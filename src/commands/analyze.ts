// aitopia analyze <file|url> [question...]: what is in a video, image or audio
// file, through the server's analyze_media tool (google/gemini-3.5-flash; ~3
// credits). Modes: summary (default), scenes (every shot, timed), ad-review,
// prompt (a prompt that re-creates it); a question gets an answer. Prints a
// readable report, or saves it (-o: .md / .txt / .json).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative } from 'node:path';
import { withSession, type Context } from '../context.js';
import { isFailed, openInAitopiaUrl } from '../envelope.js';
import { CliError, EXIT, UsageError, failureToError } from '../errors.js';
import type { Session } from '../mcp.js';
import { allowHttpLoopback, deliverEstimate, settle, startActivity } from '../results.js';
import { assertLocalFile, isRemoteUrl, uploadSource } from '../upload.js';
import { paidCall } from './generate.js';

export const ANALYZE_MODES = ['summary', 'scenes', 'ad-review', 'prompt'] as const;
export type AnalyzeMode = (typeof ANALYZE_MODES)[number];
export const ANALYZE_FORMATS = ['text', 'md', 'json'] as const;
export type AnalyzeFormat = (typeof ANALYZE_FORMATS)[number];
/** The server's question limit (characters). */
export const MAX_QUESTION_CHARS = 2000;

export interface AnalyzeOptions {
  mode?: string;
  language?: string;
  format?: string;
  output?: string;
  force?: boolean;
  dryRun?: boolean;
}

/** The tool's mode value: "ad-review" → "ad_review"; a question alone → qa (server default). */
export function toolMode(mode: string | undefined): string | undefined {
  if (mode === undefined) return undefined;
  const m = mode.toLowerCase();
  if (!(ANALYZE_MODES as readonly string[]).includes(m)) throw new UsageError(`--mode must be one of ${ANALYZE_MODES.join(', ')}, got "${mode}".`);
  return m.replace('-', '_');
}

/** --format, else the -o file's extension (.md / .txt / .json), else text. */
export function analyzeFormatFor(options: Pick<AnalyzeOptions, 'format' | 'output'>): AnalyzeFormat {
  if (options.format !== undefined) {
    const f = options.format.toLowerCase();
    if (!(ANALYZE_FORMATS as readonly string[]).includes(f)) throw new UsageError(`--format must be text, md or json, got "${options.format}".`);
    return f as AnalyzeFormat;
  }
  const ext = options.output && options.output !== '-' ? extname(options.output).slice(1).toLowerCase() : '';
  if (ext === 'json') return 'json';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'text';
}

function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h > 0 ? 2 : 1, '0');
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => Boolean(s)) : []);

/** The analysis as a readable report: plain text, or Markdown headings. */
export function renderAnalysis(payload: Record<string, unknown>, markdown: boolean): string {
  const lines: string[] = [];
  const heading = (title: string) => {
    if (lines.length > 0) lines.push('');
    lines.push(markdown ? `## ${title}` : `${title}:`);
  };
  const bullet = (text: string) => lines.push(markdown ? `- ${text}` : `  - ${text}`);
  const para = (text: string) => lines.push(markdown ? text : `  ${text.replace(/\n/g, '\n  ')}`);

  const answer = str(payload.answer);
  if (answer) {
    heading('Answer');
    para(answer);
  }
  const summary = str(payload.summary);
  if (summary) {
    heading('Summary');
    para(summary);
  }
  const scenes = Array.isArray(payload.scenes) ? payload.scenes.filter(isObject) : [];
  if (scenes.length > 0) {
    heading(`Scenes (${scenes.length})`);
    for (const scene of scenes) {
      const start = typeof scene.start === 'number' ? scene.start : 0;
      const end = typeof scene.end === 'number' ? scene.end : start;
      bullet(`${clock(start)}-${clock(end)}  ${str(scene.description) ?? ''}`);
    }
  }
  const review = isObject(payload.adReview) ? payload.adReview : undefined;
  if (review) {
    heading(typeof review.score === 'number' ? `Ad review (${review.score}/10)` : 'Ad review');
    for (const [key, label] of [['hook', 'Hook'], ['message', 'Message'], ['cta', 'CTA'], ['pacing', 'Pacing']] as const) {
      const value = str(review[key]);
      if (value) bullet(`${label}: ${value}`);
    }
    const strengths = strs(review.strengths);
    if (strengths.length > 0) bullet(`Strengths: ${strengths.join('; ')}`);
    const improvements = strs(review.improvements);
    for (const item of improvements) bullet(`Improve: ${item}`);
  }
  const recreate = str(payload.recreatePrompt);
  if (recreate) {
    heading('Prompt to re-create it');
    para(recreate);
  }
  const spoken = str(payload.spokenText);
  if (spoken) {
    heading('Speech');
    para(spoken);
  }
  const onScreen = strs(payload.onScreenText);
  if (onScreen.length > 0) {
    heading('Text on screen');
    for (const t of onScreen) bullet(t);
  }
  const audio = str(payload.audio);
  if (audio) {
    heading('Audio');
    para(audio);
  }
  const raw = str(payload.rawText);
  if (raw && lines.length === 0) para(raw);
  const note = str(payload.note);
  if (note) {
    heading('Note');
    para(note);
  }
  return `${lines.join('\n')}\n`;
}

function display(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}

async function sourceUrl(ctx: Context, session: Session, source: string): Promise<string> {
  if (isRemoteUrl(source)) return source;
  if (!ctx.out.jsonMode) ctx.out.note(`Uploading ${source}...`);
  return (await uploadSource(session.callTool, source, { allowHttpLoopback: allowHttpLoopback(ctx.serverUrl) })).assetUrl;
}

export async function analyzeCommand(ctx: Context, source: string, questionWords: string[], options: AnalyzeOptions): Promise<void> {
  if (!source) throw new UsageError('Give the video, image or audio to analyze, e.g. aitopia analyze clip.mp4.');
  if (!isRemoteUrl(source)) assertLocalFile(source);
  const question = questionWords.join(' ').trim() || undefined;
  if (question && question.length > MAX_QUESTION_CHARS) throw new UsageError(`The question is too long (${question.length} characters; at most ${MAX_QUESTION_CHARS}).`);
  const mode = toolMode(options.mode);
  const format = analyzeFormatFor(options);
  const { out } = ctx;
  const path = options.dryRun || options.output === undefined || options.output === '-' ? undefined : options.output;
  if (path) {
    if (!options.force && existsSync(path)) throw new UsageError(`${path} exists; pass --force to overwrite it.`);
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      throw new UsageError(`Cannot create the folder for ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
  }

  await withSession(ctx, async (session) => {
    const assetUrl = await sourceUrl(ctx, session, source);
    const args: Record<string, unknown> = {
      assetUrl,
      ...(mode ? { mode } : {}),
      ...(question ? { question } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(options.dryRun ? { dryRun: true } : {}),
    };
    const label = options.dryRun ? 'Checking the price' : 'Analyzing';
    const activity = startActivity(ctx, label);
    let done;
    try {
      const first = await paidCall(options.dryRun, () => session.callTool('analyze_media', args, { ...activity.callOptions, paid: !options.dryRun }));
      done = await settle(ctx, session, first, label, activity);
    } finally {
      activity.stop();
    }
    if (options.dryRun) {
      deliverEstimate(ctx, done);
      return;
    }
    if (isFailed(done)) throw failureToError(done.payload);
    const payload = done.payload;
    const open = openInAitopiaUrl(done);

    const content = format === 'json' ? `${JSON.stringify(payload, null, 2)}\n` : renderAnalysis(payload, format === 'md');
    if (path) {
      try {
        writeFileSync(path, content);
      } catch (error) {
        // Paid for: never lose it. Print it, then report the failed save.
        const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
        if (!out.jsonMode) out.line(content.replace(/\n+$/, ''));
        throw new CliError(`Could not save ${display(path)} (${reason}); the analysis is printed ${out.jsonMode ? 'in the JSON output' : 'above'}.`, EXIT.FAILED, {
          code: 'WRITE_FAILED',
          hint: 'The analysis is done and paid for; do not run it again.',
          data: { ...payload, content },
        });
      }
    }
    if (out.jsonMode) {
      out.json({ ...payload, files: path ? [path] : [], ...(open ? { openInAitopia: open } : {}) });
      return;
    }
    if (path) out.line(`${out.out.green('Saved')} ${display(path)}`);
    else out.line(content.replace(/\n+$/, ''));
  });
}
