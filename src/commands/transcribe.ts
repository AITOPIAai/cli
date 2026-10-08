import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { withSession, type Context } from '../context.js';
import { resolveOutputTarget, uniquePath } from '../download.js';
import { assetsOf, isFailed, openInAitopiaUrl, type ToolOutcome } from '../envelope.js';
import { BUY_CREDITS_URL, CliError, EXIT, UsageError, failureToError, runLimitOf } from '../errors.js';
import type { Session } from '../mcp.js';
import { allowHttpLoopback, creditsText, deliverEstimate, printRunLimitUnavailable, settle, startActivity } from '../results.js';
import { buildSrt, cuesOf, MAX_TRANSCRIBE_SECONDS, normalizeLanguage, parseTranscript, sttInput, sttModelFor, WHISPER_STT_MODEL, type Transcript } from '../transcript.js';
import { assertLocalFile, isRemoteUrl, uploadSource } from '../upload.js';
import { mediaTypeOf, sourceStem } from './edit.js';
import { paidCall } from './generate.js';

export const TRANSCRIBE_FORMATS = ['srt', 'txt', 'json'] as const;
export type TranscribeFormat = (typeof TRANSCRIBE_FORMATS)[number];

/** Stands in for a local file on --dry-run (the price does not depend on it; nothing is uploaded). */
export const DRY_RUN_MEDIA_URL = 'https://example.invalid/media';

export interface TranscribeOptions {
  words?: boolean;
  language?: string;
  format?: string;
  output?: string;
  force?: boolean;
  dryRun?: boolean;
}

/** --format, else the -o file's extension (.srt / .txt / .json), else srt. */
export function formatFor(options: Pick<TranscribeOptions, 'format' | 'output'>): TranscribeFormat {
  if (options.format !== undefined) {
    const format = options.format.toLowerCase();
    if (!(TRANSCRIBE_FORMATS as readonly string[]).includes(format)) throw new UsageError(`--format must be srt, txt or json, got "${options.format}".`);
    return format as TranscribeFormat;
  }
  const ext = options.output && options.output !== '-' ? extname(options.output).slice(1).toLowerCase() : '';
  return (TRANSCRIBE_FORMATS as readonly string[]).includes(ext) ? (ext as TranscribeFormat) : 'srt';
}

function isAitopiaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'aitopia.ai' || host.endsWith('.aitopia.ai');
  } catch {
    return false;
  }
}

function display(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}

function clock(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The file's text in the chosen format. */
export function renderTranscript(transcript: Transcript, format: TranscribeFormat, perWord: boolean, modelId: string): string {
  if (format === 'txt') return `${transcript.text}\n`;
  if (format === 'json') {
    return `${JSON.stringify(
      {
        modelId,
        ...(transcript.language ? { language: transcript.language } : {}),
        ...(transcript.durationSec !== undefined ? { durationSec: transcript.durationSec } : {}),
        text: transcript.text,
        ...(transcript.words.length > 0 ? { words: transcript.words } : {}),
        ...(transcript.segments.length > 0 ? { segments: transcript.segments } : {}),
      },
      null,
      2,
    )}\n`;
  }
  return buildSrt(cuesOf(transcript, perWord));
}

/** Where the transcript goes: undefined = stdout (-o -, or txt without -o). */
export function transcriptPath(output: string | undefined, format: TranscribeFormat, stem: string, force: boolean): string | undefined {
  if (output === '-' || (output === undefined && format === 'txt')) return undefined;
  const target = resolveOutputTarget(output);
  const path = target.kind === 'dir' ? join(target.path, `${stem}.${format}`) : target.path;
  return uniquePath(path, force);
}

async function paidStep(ctx: Context, session: Session, tool: string, args: Record<string, unknown>, label: string): Promise<ToolOutcome> {
  const activity = startActivity(ctx, label);
  try {
    const first = await paidCall(false, () => session.callTool(tool, args, { ...activity.callOptions, paid: true }));
    return await settle(ctx, session, first, label, activity);
  } finally {
    activity.stop();
  }
}

/** --dry-run of a video: extracting the audio and transcribing it, priced together. */
function deliverTwoStepEstimate(ctx: Context, extract: ToolOutcome, transcribe: ToolOutcome, modelId: string): void {
  for (const step of [extract, transcribe]) if (isFailed(step)) throw failureToError(step.payload);
  const credits = (o: ToolOutcome) => (typeof o.payload.credits === 'number' ? o.payload.credits : undefined);
  const a = credits(extract);
  const b = credits(transcribe);
  const total = a !== undefined && b !== undefined ? a + b : undefined;
  const balanceOf = (o: ToolOutcome) => (o.payload.balance && typeof o.payload.balance === 'object' ? (o.payload.balance as Record<string, unknown>).creditsForGeneration : undefined);
  const balance = balanceOf(transcribe) ?? balanceOf(extract);
  const affordable =
    typeof balance === 'string' && balance.toLowerCase() === 'unlimited' ? true : typeof balance === 'number' && total !== undefined ? balance >= total : undefined;
  const runLimit = runLimitOf(transcribe.payload) ?? runLimitOf(extract.payload);
  const { out } = ctx;
  if (out.jsonMode) {
    out.json({
      status: 'estimate',
      credits: total ?? null,
      steps: [
        { tool: 'audio_tools', operation: 'extract', credits: a ?? null },
        { tool: 'run_model', modelId, credits: b ?? null },
      ],
      ...(balance !== undefined ? { balance: { creditsForGeneration: balance } } : {}),
      ...(affordable !== undefined ? { affordable } : {}),
      ...(runLimit ? { runLimit } : {}),
    });
    return;
  }
  out.line(`${out.out.bold('Estimate:')} ${creditsText(total)} (${creditsText(a)} to extract the audio, ${creditsText(b)} to transcribe it)`);
  out.line(`Balance: ${balance === undefined || balance === null ? 'unknown' : `${creditsText(balance)} available`}`);
  if (runLimit) printRunLimitUnavailable(out, runLimit);
  else if (affordable === true) out.line(`Affordable: ${out.out.green('yes')}`);
  else if (affordable === false) {
    out.line(`Affordable: ${out.out.red('no, not enough credits')}`);
    out.line(`Buy credits: ${BUY_CREDITS_URL}`);
  }
  out.line(out.out.dim('Nothing was submitted or charged.'));
}

/** What a probe_media answer says the file is: video (has a picture), audio, or neither. */
export function probedKind(payload: Record<string, unknown>): 'video' | 'audio' | undefined {
  if (payload.hasVideo === true && payload.hasAudio !== false) return 'video';
  if (payload.hasAudio === true) return 'audio';
  return undefined;
}

/** Refuses media longer than the server takes in one run (2 hours), before anything is spent. */
export function checkDuration(durationSec: unknown, source: string): void {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= MAX_TRANSCRIBE_SECONDS) return;
  throw new CliError(`${source} is about ${Math.round(durationSec / 60)} minutes; transcribe takes at most 2 hours per run. Nothing was spent.`, EXIT.FAILED, {
    code: 'MEDIA_TOO_LONG',
    hint: 'Split it into parts of at most 2 hours first (e.g. with `aitopia run trim_video`), transcribe each part, and shift each part\'s cue times by its start.',
    data: { durationSec, maxDurationSec: MAX_TRANSCRIBE_SECONDS },
  });
}

/**
 * probe_media (free): whether a file of unknown type is a video or audio, and
 * that it is not over 2 hours. Nothing is spent if it fails.
 */
async function probeKind(session: Session, url: string, source: string): Promise<'video' | 'audio'> {
  const outcome = await session.callTool('probe_media', { assetUrl: url });
  if (isFailed(outcome)) throw failureToError(outcome.payload);
  checkDuration(outcome.payload.durationSec, source);
  const kind = probedKind(outcome.payload);
  if (!kind) {
    throw new CliError(`${source} has no sound to transcribe.`, EXIT.FAILED, {
      code: 'NO_AUDIO',
      hint: 'Give an audio file or a video with sound. Nothing was spent.',
      data: outcome.payload,
    });
  }
  return kind;
}

/** "(N credits)" from a dryRun of the transcription; "(price per the model)" when it cannot be told. */
async function priceNote(session: Session, modelId: string, audioUrl: string, language: string | undefined): Promise<string> {
  try {
    const estimate = await session.callTool('run_model', { modelId, input: sttInput(modelId, audioUrl, language), dryRun: true });
    if (!isFailed(estimate) && typeof estimate.payload.credits === 'number') return `(${creditsText(estimate.payload.credits)})`;
  } catch {
    // the price note is informative only
  }
  return '(price per the model)';
}

/**
 * aitopia transcribe <file|url>: speech to text with xai/grok-speech-to-text
 * (word timings, cues built here), or openai/whisper for a --language Grok
 * does not cover. A video's sound is extracted first (audio_tools extract).
 * A URL whose type the name does not tell is probed first (free); media
 * the probe finds longer than 2 hours is refused before anything is spent
 * (a duration not known here is left to the models).
 */
export async function transcribeCommand(ctx: Context, source: string, options: TranscribeOptions): Promise<void> {
  if (!source) throw new UsageError('Give the audio or video to transcribe, e.g. aitopia transcribe talk.mp3.');
  const remote = isRemoteUrl(source);
  if (!remote) assertLocalFile(source);
  const media = mediaTypeOf(source);
  if (media === 'image') throw new UsageError(`${source} is an image; transcribe takes an audio or video file.`);
  const language = normalizeLanguage(options.language);
  const format = formatFor(options);
  const modelId = sttModelFor(language);
  const stem = sourceStem(source) || 'transcript';
  const { out } = ctx;
  if (options.words && modelId === WHISPER_STT_MODEL && !out.jsonMode) {
    out.warn(`--language ${language} runs Whisper, which gives no word timings; the cues follow its segments.`);
  }
  // Where it goes, decided (and the folder made) before anything is spent.
  const path = options.dryRun ? undefined : transcriptPath(out.jsonMode && options.output === undefined && format === 'txt' ? '-' : options.output, format, stem, options.force === true);
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      throw new UsageError(`Cannot create the folder for ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
  }

  await withSession(ctx, async (session) => {
    if (options.dryRun) {
      const url = remote ? source : DRY_RUN_MEDIA_URL;
      let kind = media;
      if (!kind && remote) kind = await probeKind(session, source, source);
      if (!kind && !out.jsonMode) out.note('The file type is not known from its name; priced as audio (a video costs 1 credit more to extract its sound).');
      const activity = startActivity(ctx, 'Checking the price');
      try {
        const run = await session.callTool('run_model', { modelId, input: sttInput(modelId, url, language), dryRun: true });
        if (kind !== 'video') {
          activity.stop();
          deliverEstimate(ctx, run);
          return;
        }
        const extract = await session.callTool('audio_tools', { input: { assetUrl: url, operation: 'extract' }, dryRun: true });
        activity.stop();
        deliverTwoStepEstimate(ctx, extract, run, modelId);
      } finally {
        activity.stop();
      }
      return;
    }

    let kind = media;
    // A URL of unknown type is probed before anything is uploaded or paid.
    if (!kind && remote) kind = await probeKind(session, source, source);
    let mediaUrl = source;
    if (!remote || (kind === 'video' && !isAitopiaUrl(source))) {
      // A local file is uploaded; a video URL from elsewhere is imported (audio_tools takes AITOPIA files).
      if (!out.jsonMode) out.note(`Uploading ${source}...`);
      mediaUrl = (
        await uploadSource(session.callTool, source, { cache: session.uploads,
          wait: (o) => settle(ctx, session, o, `Importing ${source}`),
          allowHttpLoopback: allowHttpLoopback(ctx.serverUrl),
        })
      ).assetUrl;
    }
    if (!kind) kind = await probeKind(session, mediaUrl, source);

    let audioUrl = mediaUrl;
    if (kind === 'video') {
      if (!out.jsonMode) out.note('Extracting the audio (1 credit)...');
      const extracted = await paidStep(ctx, session, 'audio_tools', { input: { assetUrl: mediaUrl, operation: 'extract' } }, 'Extracting the audio');
      const url = assetsOf(extracted)[0]?.url;
      if (!url) {
        throw new CliError('Extracting the audio returned no file.', EXIT.FAILED, { code: 'NO_AUDIO', hint: 'Check that the video has sound.', data: extracted.payload });
      }
      audioUrl = url;
    }

    if (!out.jsonMode) out.note(`Transcribing with ${modelId} ${await priceNote(session, modelId, audioUrl, language)}...`);
    const done = await paidStep(ctx, session, 'run_model', { modelId, input: sttInput(modelId, audioUrl, language) }, 'Transcribing');
    const transcript = parseTranscript(done.payload.output);
    const cues = cuesOf(transcript, options.words === true);
    const open = openInAitopiaUrl(done);
    if (!transcript.text && cues.length === 0) {
      throw new CliError('No speech was found in the file.', EXIT.FAILED, {
        code: 'NO_SPEECH',
        hint: 'The transcription ran (and was charged); it heard no words. Check that the file has speech.',
        data: { ...done.payload, modelId },
      });
    }

    const content = renderTranscript(transcript, format, options.words === true, modelId);
    if (path) {
      try {
        writeFileSync(path, content);
      } catch (error) {
        // Paid for: never lose it. Print it, then report the failed save.
        const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
        if (!out.jsonMode) out.line(content.replace(/\n+$/, ''));
        throw new CliError(`Could not save ${display(path)} (${reason}); the transcript is printed ${out.jsonMode ? 'in the JSON output' : 'above'}.`, EXIT.FAILED, {
          code: 'WRITE_FAILED',
          hint: `The transcription is done and paid for; do not run it again: keep the text from ${out.jsonMode ? 'the JSON output (content)' : 'above'}.`,
          data: { status: 'completed', modelId, text: transcript.text, format, content, cues, audioUrl },
        });
      }
    }

    if (out.jsonMode) {
      out.json({
        status: 'completed',
        modelId,
        ...(transcript.language ? { language: transcript.language } : {}),
        ...(transcript.durationSec !== undefined ? { durationSec: transcript.durationSec } : {}),
        text: transcript.text,
        format,
        cueCount: cues.length,
        cues,
        ...(options.words ? { words: transcript.words } : {}),
        files: path ? [path] : [],
        audioUrl,
        ...(open ? { openInAitopia: open } : {}),
      });
      return;
    }
    if (!path) {
      out.line(content.replace(/\n+$/, ''));
    } else {
      const facts = [
        format === 'srt' ? `${cues.length} cue${cues.length === 1 ? '' : 's'}` : undefined,
        transcript.language,
        transcript.durationSec !== undefined ? clock(transcript.durationSec) : undefined,
      ].filter(Boolean);
      out.line(`${out.out.green('Saved')} ${display(path)}${facts.length > 0 ? ` (${facts.join(', ')})` : ''}`);
    }
    if (open) out.note(`${out.err.dim('Open in AITOPIA:')} ${open}`);
  });
}
