// aitopia dub <file|url> --to <language>: translate the speech of a video (up
// to 60 s) and dub it, through the server's dub_video tool: transcribe,
// translate, speak the translation in the speaker's cloned voice (or one of
// your voices), optional lip sync. The price is checked first (a free dry run
// that returns a planToken), then that exact plan runs. Saves the dubbed video
// and the translated subtitles (.srt) next to it.
import { execFile } from 'node:child_process';
import { extname, relative } from 'node:path';
import { withSession, type Context } from '../context.js';
import { downloadAsset, resolveOutputTarget, slugify, uniquePath, type OutputTarget } from '../download.js';
import { assetsOf, buyCreditsUrl, isFailed, openInAitopiaUrl, type ToolOutcome } from '../envelope.js';
import { CliError, EXIT, UsageError, failureToError, runLimitOf } from '../errors.js';
import { addReadyResult, setActiveRun } from '../interrupt.js';
import type { Session } from '../mcp.js';
import { describeProgress } from '../output.js';
import { isRunning, waitForRun } from '../poll.js';
import { allowHttpLoopback, creditsText, printRunLimitUnavailable, startActivity, type Activity, type DeliverOptions } from '../results.js';
import { resolveVoice } from '../resolve.js';
import { assertLocalFile, formatBytes, isRemoteUrl, uploadSource } from '../upload.js';
import { mediaTypeOf, sourceStem } from './edit.js';
import { paidCall } from './generate.js';

/** The server's length limit (seconds); checked there, and here first when ffprobe is installed. */
export const MAX_DUB_SECONDS = 60;
/** A local video larger than this is refused before it is uploaded. */
export const MAX_DUB_VIDEO_BYTES = 100 * 1024 * 1024;

export const DUB_CONSENT_TEXT =
  "Cloning the speaker's voice needs --consent (or --yes-clone): it confirms the video is your own voice, or that the speaker gave you permission to clone it. Never clone anyone else (no celebrities or public figures). Or dub with one of your voices: --voice <name|id> (see `aitopia voices`).";

export interface DubOptions extends DeliverOptions {
  to?: string;
  from?: string;
  voice?: string;
  lipsync?: boolean;
  lipsyncModel?: string;
  maxCredits?: number;
  dryRun?: boolean;
  consent?: boolean;
  yesClone?: boolean;
}

/** One step of a dub plan, as dub_video reports it. */
export interface DubStep {
  step?: string;
  label?: string;
  status?: string;
  credits?: number | null;
  basis?: string;
  error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A field of the payload, or of `details` (failures carry tool facts there). */
function field(payload: Record<string, unknown>, key: string): unknown {
  if (payload[key] !== undefined) return payload[key];
  return isObject(payload.details) ? payload.details[key] : undefined;
}

export function stepsOf(payload: Record<string, unknown>): DubStep[] {
  const raw = field(payload, 'steps');
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).map((s) => ({
    ...(str(s.step) ? { step: str(s.step) } : {}),
    ...(str(s.label) ? { label: str(s.label) } : {}),
    ...(str(s.status) ? { status: str(s.status) } : {}),
    ...(s.credits === null ? { credits: null } : num(s.credits) !== undefined ? { credits: num(s.credits) } : {}),
    ...(str(s.basis) ? { basis: str(s.basis) } : {}),
    ...(str(s.error) ? { error: str(s.error) } : {}),
  }));
}

const STATUS_WORDS: Record<string, string> = { reused: 'cached', completed: 'done', failed: 'failed', skipped: 'not run', running: 'running' };

/** "  1. Transcribe the speech · 2 credits" (with --statuses: "· done"). */
export function dubStepLines(steps: DubStep[], options: { statuses?: boolean; basis?: boolean } = {}): string[] {
  const lines: string[] = [];
  for (const [i, step] of steps.entries()) {
    const bits = [`${i + 1}. ${step.label ?? step.step ?? 'step'}`];
    if (step.credits === null) bits.push('price unknown');
    else if (step.credits !== undefined) bits.push(creditsText(step.credits));
    const status = step.status ? STATUS_WORDS[step.status] : undefined;
    if (status && (options.statuses || step.status === 'reused')) bits.push(status);
    lines.push(`  ${bits.join(' · ')}`);
    if (options.basis && step.basis) lines.push(`     ${step.basis}`);
    if (step.error) lines.push(`     ${step.error}`);
  }
  return lines;
}

type ExecFn = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;

const execFileAsync: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve({ stdout: String(stdout) })));
  });

/**
 * The length of a local video in seconds, from ffprobe; undefined when ffprobe
 * is not installed or cannot read the file (the server measures it anyway).
 */
export async function probeDuration(path: string, exec: ExecFn = execFileAsync): Promise<number | undefined> {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { timeout: 15_000 });
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/** Checks before connecting: options, then a local file (exists, a video, at most 100 MB, at most 60 s when ffprobe can tell). */
async function precheck(source: string, options: DubOptions): Promise<void> {
  if (!source) throw new UsageError('Give the video to dub, e.g. aitopia dub clip.mp4 --to Spanish.');
  if (!options.to?.trim()) throw new UsageError('Say which language to dub into with --to, e.g. --to Spanish or --to de.');
  if (options.voice !== undefined && !options.voice.trim()) throw new UsageError('--voice needs a voice name or id (see `aitopia voices`).');
  if (options.lipsyncModel !== undefined && !options.lipsyncModel.trim()) throw new UsageError('--lipsync-model needs a model id.');
  if (!options.dryRun && options.voice === undefined && !options.consent && !options.yesClone) throw new UsageError(DUB_CONSENT_TEXT);
  const media = mediaTypeOf(source);
  if (media && media !== 'video') throw new UsageError(`dub takes a video; ${source} looks like ${media === 'image' ? 'an image' : 'audio'}.`);
  if (isRemoteUrl(source)) return;
  const { size } = assertLocalFile(source);
  if (size > MAX_DUB_VIDEO_BYTES) {
    throw new UsageError(`dub takes a video of at most 100 MB; ${source} is ${formatBytes(size)}. Make it smaller first (shorten it, or lower its resolution or bitrate).`);
  }
  const seconds = await probeDuration(source);
  if (seconds !== undefined && seconds > MAX_DUB_SECONDS + 0.5) {
    throw new UsageError(
      `dub takes a video of at most ${MAX_DUB_SECONDS} seconds for now; ${source} is ${Math.round(seconds)} s.`,
      `Cut it into parts of ${MAX_DUB_SECONDS} s or less (e.g. aitopia edit ${source} "trim to the first 60 seconds") and dub each part. Nothing was uploaded or charged.`,
    );
  }
}

function display(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}

/** The dub_video arguments of this command (without dryRun / planToken). */
function dubArgs(videoUrl: string, options: DubOptions, voiceId: string | undefined): Record<string, unknown> {
  const lipsync = options.lipsync === true || options.lipsyncModel !== undefined;
  return {
    videoUrl,
    targetLanguage: (options.to as string).trim(),
    ...(options.from?.trim() ? { sourceLanguage: options.from.trim() } : {}),
    ...(voiceId ? { voiceId } : {}),
    ...(options.consent || options.yesClone ? { consent: true } : {}),
    ...(lipsync ? { lipsync: true } : {}),
    ...(options.lipsyncModel ? { lipsyncModel: options.lipsyncModel.trim() } : {}),
    ...(options.maxCredits !== undefined ? { maxCredits: options.maxCredits } : {}),
  };
}

/** A failure: the steps (which ran, which failed) are printed; a partial run says the finished steps were paid for. */
function dubFailure(ctx: Context, outcome: ToolOutcome): CliError {
  const p = outcome.payload;
  const base = failureToError(p, { buyCreditsUrl: buyCreditsUrl(outcome), openInAitopia: openInAitopiaUrl(outcome) });
  const steps = stepsOf(p);
  // A step failed after the run started (the answer may read "failed" or "partial").
  const stepFailed = p.status === 'partial' || field(p, 'failedStep') !== undefined;
  if (!ctx.out.jsonMode && steps.length > 0 && stepFailed) {
    for (const line of dubStepLines(steps, { statuses: true })) ctx.out.line(line);
  }
  const hint =
    base.code === 'CONSENT_REQUIRED'
      ? DUB_CONSENT_TEXT
      : base.code === 'PLAN_EXPIRED' || base.code === 'PRICE_CHANGED'
        ? 'Nothing ran or was charged. Run the command again: the price is checked again first.'
        : stepFailed
          ? (str(field(p, 'note')) ?? 'The finished steps stay charged; nothing after the failed step ran.')
          : base.hint;
  return new CliError(base.message, base.code === 'CONSENT_REQUIRED' ? EXIT.USAGE : base.exitCode, { code: base.code, hint, notes: base.notes, data: base.data });
}

async function follow(ctx: Context, session: Session, first: ToolOutcome, activity: Activity, paid: boolean): Promise<ToolOutcome> {
  if (!isRunning(first)) return first;
  const spinner = activity.spinner();
  try {
    return await waitForRun(session.callTool, first, {
      onStart: (runToken) => {
        if (paid) setActiveRun(runToken);
        ctx.out.debug(`run token: ${runToken}`);
      },
      onProgress: (p) => {
        spinner.update(describeProgress(p, { eta: !ctx.out.stderrIsTTY }));
        spinner.setEta(p.etaSeconds);
      },
      callOptions: activity.callOptions,
      onNote: (note) => ctx.out.debug(`server: ${note}`),
    });
  } finally {
    activity.stop();
    if (paid) setActiveRun(undefined);
  }
}

/** --dry-run: the steps with their prices, the total and the balance. Exit 0, also when it is not affordable. */
function deliverDubEstimate(ctx: Context, outcome: ToolOutcome, options: DubOptions): void {
  const { out } = ctx;
  const p = outcome.payload;
  if (out.jsonMode) {
    out.json(p);
    return;
  }
  const duration = num(p.durationSec);
  out.line(`Dub into ${str(p.targetLanguage) ?? options.to}${duration !== undefined ? ` (${duration} s video)` : ''}${p.lipsync === true ? ', with lip sync' : ''}:`);
  for (const line of dubStepLines(stepsOf(p), { basis: true })) out.line(line);
  const coverage = p.complete === false ? ' (not every step could be priced)' : '';
  out.line(`${out.out.bold('Total:')} ${creditsText(num(p.totalCredits))}${coverage}`);
  const balance = isObject(p.balance) ? p.balance.creditsForGeneration : undefined;
  if (balance !== undefined && balance !== null) out.line(`Balance: ${creditsText(balance)} available`);
  const runLimit = runLimitOf(p);
  if (runLimit) printRunLimitUnavailable(out, runLimit, buyCreditsUrl(outcome));
  else if (p.affordable === false) {
    out.line(out.out.red('Not enough credits for this dub.'));
    out.line(`Buy credits: ${str(p.buyCreditsUrl) ?? buyCreditsUrl(outcome)}`);
  } else if (p.affordable === true) out.line(`Affordable: ${out.out.green('yes')}`);
  else if (typeof p.balanceNote === 'string') out.note(p.balanceNote);
  if (p.withinBudget === false) {
    const limit = num(p.maxCredits) ?? options.maxCredits;
    out.line(out.out.red(`Over your --max-credits limit${limit !== undefined ? ` of ${creditsText(limit)}` : ''}: it would not run.`));
  }
  if (str(p.voiceNote) && options.voice === undefined) {
    out.line(`The speaker's voice is cloned from this video and saved in your voices; the run needs ${options.consent || options.yesClone ? '--consent (given)' : '--consent'}.`);
  }
  out.line(out.out.dim('Nothing was run or charged.'));
}

/** Downloads one file; never throws (a failed download is reported, the result was paid for). */
async function save(ctx: Context, url: string, target: OutputTarget, options: DubOptions, assetName?: string): Promise<{ file?: string; error?: string }> {
  try {
    ctx.out.debug(`downloading ${url}`);
    const file = await downloadAsset(url, { target, index: 0, total: 1, assetName, force: options.force === true, allowHttpLoopback: allowHttpLoopback(ctx.serverUrl) });
    return { file };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The .srt path next to the saved video: clip-es.mp4 → clip-es.srt (-1, -2 ... when taken, unless --force). */
export function srtPathFor(videoFile: string, force: boolean): string {
  const ext = extname(videoFile);
  return uniquePath(`${ext ? videoFile.slice(0, -ext.length) : videoFile}.srt`, force);
}

async function deliverDub(ctx: Context, outcome: ToolOutcome, options: DubOptions, name: string): Promise<void> {
  const { out } = ctx;
  const p = outcome.payload;
  const open = openInAitopiaUrl(outcome);
  const videoUrl = str(p.assetUrl) ?? assetsOf(outcome)[0]?.url;
  const srtUrl = str(p.srtUrl);
  const files: string[] = [];
  const downloadErrors: string[] = [];
  const target = resolveOutputTarget(options.output);

  if (videoUrl) {
    const entry = addReadyResult({ assetUrl: videoUrl, ...(open ? { openInAitopia: open } : {}) });
    if (options.download === false) {
      if (!out.jsonMode) out.line(videoUrl);
    } else {
      const result = await save(ctx, videoUrl, target, options, target.kind === 'dir' ? name : undefined);
      if (result.file) {
        entry.file = result.file;
        files.push(result.file);
        if (!out.jsonMode) out.line(`${out.out.green('Saved')} ${display(result.file)}`);
      } else {
        downloadErrors.push(`video: ${result.error ?? 'download failed'}`);
        if (!out.jsonMode) {
          out.note(out.err.red(`Could not download the video: ${result.error}`));
          out.line(videoUrl);
        }
      }
    }
  } else {
    out.warn('The dub finished but returned no video.');
  }

  if (srtUrl) {
    addReadyResult({ assetUrl: srtUrl, label: 'subtitles', ...(open ? { openInAitopia: open } : {}) });
    const videoFile = files[0];
    if (options.download === false || !videoFile) {
      if (!out.jsonMode) out.line(`Subtitles: ${srtUrl}`);
    } else {
      const result = await save(ctx, srtUrl, { kind: 'file', path: srtPathFor(videoFile, options.force === true) }, { ...options, force: true });
      if (result.file) {
        files.push(result.file);
        if (!out.jsonMode) out.line(`${out.out.green('Saved')} ${display(result.file)} (subtitles)`);
      } else {
        downloadErrors.push(`subtitles: ${result.error ?? 'download failed'}`);
        if (!out.jsonMode) {
          out.note(out.err.red(`Could not download the subtitles: ${result.error}`));
          out.line(`Subtitles: ${srtUrl}`);
        }
      }
    }
  } else if (str(p.srtError) && !out.jsonMode) {
    out.warn(`${str(p.srtError)}`);
    const translated = str(p.translatedText);
    if (translated) out.line(translated);
  }

  if (out.jsonMode) {
    if (downloadErrors.length === 0) {
      out.json({ ...p, files });
      return;
    }
  } else {
    const voiceId = str(p.voiceId);
    if (p.voiceCloned === true && voiceId) out.line("Cloned the speaker's voice; it is saved in your voices.");
    if (voiceId && options.voice === undefined) out.line(`Next time: --voice ${voiceId}`);
    const warning = str(p.warning);
    if (warning) out.warn(warning);
    // The server's note names the API argument (voiceId); the line above says it the CLI way.
    const note = str(p.note)?.replace(/\s*Pass voiceId "[^"]*" next time[^.]*\./, '').trim();
    if (note) out.note(note);
    const total = num(p.totalCredits);
    if (total !== undefined) out.line(`Total: ${creditsText(total)}`);
    if (open) out.line(`${out.out.dim('Open in AITOPIA:')} ${open}`);
  }
  if (downloadErrors.length > 0) {
    throw new CliError(`Could not download ${downloadErrors.length === 1 ? 'a file' : `${downloadErrors.length} files`}: ${downloadErrors.join('; ')}`, EXIT.FAILED, {
      code: 'DOWNLOAD_FAILED',
      hint: 'The dub is done and paid for; do not run it again. Download the files from the URLs above or from AITOPIA.',
      data: { ...p, files, downloadErrors },
    });
  }
}

export async function dubCommand(ctx: Context, source: string, options: DubOptions): Promise<void> {
  await precheck(source, options);
  const { out } = ctx;
  const name = `${sourceStem(source) || 'video'}-${slugify(options.to) || 'dubbed'}`;

  await withSession(ctx, async (session) => {
    // Before the upload: an unknown voice stops here.
    let voiceId: string | undefined;
    if (options.voice !== undefined) {
      const voice = await resolveVoice(session, options.voice);
      voiceId = voice.id;
      if (!out.jsonMode) out.note(`Voice: ${voice.name}`);
    }
    let videoUrl = source;
    if (!isRemoteUrl(source)) {
      if (!out.jsonMode) out.note(`Uploading ${source}...`);
      videoUrl = (await uploadSource(session.callTool, source, { cache: session.uploads, allowHttpLoopback: allowHttpLoopback(ctx.serverUrl) })).assetUrl;
    }
    const args = dubArgs(videoUrl, options, voiceId);

    // 1. The price (free): the steps, the total and a planToken for exactly this plan.
    const pricing = startActivity(ctx, 'Checking the price');
    let estimate: ToolOutcome;
    try {
      estimate = await follow(ctx, session, await session.callTool('dub_video', { ...args, dryRun: true }, pricing.callOptions), pricing, false);
    } finally {
      pricing.stop();
    }
    if (isFailed(estimate)) throw dubFailure(ctx, estimate);
    if (options.dryRun) {
      deliverDubEstimate(ctx, estimate, options);
      return;
    }
    const e = estimate.payload;
    const total = num(e.totalCredits);
    if (e.withinBudget === false) {
      if (!out.jsonMode) for (const line of dubStepLines(stepsOf(e))) out.line(line);
      throw new CliError(`This dub costs ${creditsText(total)}, more than your limit of ${creditsText(options.maxCredits)}.`, EXIT.FAILED, {
        code: 'OVER_BUDGET',
        hint: 'Nothing ran and nothing was charged. Raise --max-credits, or leave out --lipsync.',
        data: e,
      });
    }
    if (!out.jsonMode) out.note(`Dubbing into ${(options.to as string).trim()} · ${creditsText(total)} (${stepsOf(e).length} steps; --dry-run lists them)`);

    // 2. The run, at that price.
    const planToken = str(e.planToken);
    const activity = startActivity(ctx, 'Dubbing');
    let done: ToolOutcome;
    try {
      const first = await paidCall(false, () => session.callTool('dub_video', { ...args, ...(planToken ? { planToken } : {}) }, { ...activity.callOptions, paid: true }));
      done = await follow(ctx, session, first, activity, true);
    } finally {
      activity.stop();
    }
    if (isFailed(done) || done.payload.status === 'partial') throw dubFailure(ctx, done);
    await deliverDub(ctx, done, options, name);
  });
}
