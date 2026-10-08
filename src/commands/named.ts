// Named edit tools: one command per MCP tool (upscale_image / upscale_video,
// remove_background, outpaint_image, reframe, motion_control, voice_change).
// AITOPIA picks the model for each (with a fallback); the price is checked on
// the file itself, so a local file is uploaded first, also for --dry-run (free).
import { withSession, type Context } from '../context.js';
import { isFailed, openInAitopiaUrl, type ToolOutcome } from '../envelope.js';
import { CliError, EXIT, UsageError, failureToError } from '../errors.js';
import type { Session } from '../mcp.js';
import { allowHttpLoopback, deliver, deliverEstimate, settle, startActivity, type DeliverOptions } from '../results.js';
import { checkScopeOptions, resolveScope, type ScopeOptions } from '../resolve.js';
import { assertLocalFile, isRemoteUrl, uploadSource } from '../upload.js';
import { mediaTypeOf, planLines, planOf, sourceStem } from './edit.js';
import { paidCall } from './generate.js';

export const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21'] as const;
export const UPSCALE_RESOLUTIONS = ['1080p', '2160p'] as const;
export const MOTION_MODES = ['animate', 'replace'] as const;
/** The voice_change presets (ElevenLabs Voice Changer, as the server lists them). */
export const VOICE_PRESETS = [
  'Rachel', 'Drew', 'Clyde', 'Paul', 'Aria', 'Domi', 'Dave', 'Roger', 'Fin', 'Sarah', 'James', 'Jane', 'Juniper',
  'Arabella', 'Hope', 'Bradford', 'Reginald', 'Gaming', 'Austin', 'Kuon', 'Blondie', 'Priyanka', 'Alexandra',
  'Monika', 'Mark', 'Grimblewood',
] as const;
/** Pixels outpaint may add per side. */
export const OUTPAINT_MAX_PIXELS = 700;

/** Probe codecs of a still image (ffprobe reads an image as a one-frame video). */
const IMAGE_CODECS = new Set(['png', 'mjpeg', 'jpeg', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif', 'heic', 'heif', 'jpegxl']);

export interface NamedToolOptions extends DeliverOptions, ScopeOptions {
  name?: string;
  dryRun?: boolean;
}

type Media = 'image' | 'video' | 'audio';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks a source before connecting: a local file must exist; a type its extension rules out is a usage error. */
function checkSource(source: string, what: string, accepts: Media[], example: string): void {
  if (!source) throw new UsageError(`Give the ${what}, e.g. ${example}.`);
  if (!isRemoteUrl(source)) assertLocalFile(source);
  const media = mediaTypeOf(source);
  if (media && !accepts.includes(media)) {
    throw new UsageError(`${source} is ${media === 'image' ? 'an image' : `a${media === 'audio' ? 'n' : ''} ${media}`}; this takes ${accepts.map((m) => (m === 'image' ? 'an image' : m === 'audio' ? 'an audio file' : 'a video')).join(' or ')}.`);
  }
}

/** The file's URL: a URL as given, a local file uploaded first (free, also for --dry-run: the price is checked on the file). */
async function sourceUrl(ctx: Context, session: Session, source: string): Promise<string> {
  if (isRemoteUrl(source)) return source;
  if (!ctx.out.jsonMode) ctx.out.note(`Uploading ${source}...`);
  return (await uploadSource(session.callTool, source, { cache: session.uploads, allowHttpLoopback: allowHttpLoopback(ctx.serverUrl) })).assetUrl;
}

/** A probe_media answer: image (one still frame), video or audio. */
export function probedMedia(payload: Record<string, unknown>): Media | undefined {
  const video = isObject(payload.video) ? payload.video : undefined;
  if (payload.hasVideo === true) {
    const still = video !== undefined && IMAGE_CODECS.has(String(video.codec).toLowerCase()) && !(Number(payload.durationSec) > 0.5);
    return still ? 'image' : 'video';
  }
  return payload.hasAudio === true ? 'audio' : undefined;
}

async function probeMedia(session: Session, url: string, source: string): Promise<Media> {
  const outcome = await session.callTool('probe_media', { assetUrl: url });
  if (isFailed(outcome)) throw failureToError(outcome.payload);
  const media = probedMedia(outcome.payload);
  if (!media) {
    throw new CliError(`Could not tell whether ${source} is an image or a video.`, EXIT.FAILED, {
      code: 'UNKNOWN_MEDIA',
      hint: 'Give a file whose name ends in its type (.png, .mp4, ...). Nothing was spent.',
      data: outcome.payload,
    });
  }
  return media;
}

/**
 * The estimate of a named edit tool, as deliverEstimate prints it: its total as
 * `credits`, and (human mode) its steps first.
 */
function withEstimateCredits(ctx: Context, outcome: ToolOutcome): ToolOutcome {
  const p = outcome.payload;
  if (isFailed(outcome) || p.status !== 'estimate') return outcome;
  const plan = planOf(p);
  if (plan && !ctx.out.jsonMode && plan.steps.length > 1) for (const line of planLines(plan)) ctx.out.line(line);
  return p.credits === undefined && typeof p.totalCredits === 'number' ? { ...outcome, payload: { ...p, credits: p.totalCredits } } : outcome;
}

/** A run that stopped part way (status partial): the finished file is kept, exit 1. */
function partialFailure(outcome: ToolOutcome): CliError | undefined {
  const p = outcome.payload;
  if (p.status !== 'partial') return undefined;
  const last = typeof p.lastAssetUrl === 'string' ? p.lastAssetUrl : undefined;
  const open = openInAitopiaUrl(outcome);
  return new CliError(typeof p.error === 'string' ? p.error : 'A step failed.', EXIT.FAILED, {
    code: typeof p.code === 'string' ? p.code : 'FAILED',
    notes: [...(last ? [`Last finished file: ${last}`] : []), ...(open ? [`Open in AITOPIA: ${open}`] : [])],
    hint: 'Paid steps are not retried. The finished steps are saved in AITOPIA.',
    data: { ...p },
  });
}

/** Runs one named tool with the shared flags (assetName, dryRun, project/folder), follows it and saves its file. */
async function runNamed(
  ctx: Context,
  session: Session,
  tool: string,
  args: Record<string, unknown>,
  scope: Record<string, unknown>,
  options: NamedToolOptions,
  label: string,
  name: string,
): Promise<void> {
  const full: Record<string, unknown> = { ...args, ...scope };
  if (options.name) full.assetName = options.name;
  if (options.dryRun) full.dryRun = true;
  const activity = startActivity(ctx, options.dryRun ? 'Checking the price' : label);
  try {
    const first = await paidCall(options.dryRun, () => session.callTool(tool, full, { ...activity.callOptions, paid: !options.dryRun }));
    // A price check answers inline; an older server may still hand a slow one a run token.
    const done = await settle(ctx, session, first, options.dryRun ? 'Checking the price' : label, activity);
    activity.stop();
    if (options.dryRun) {
      deliverEstimate(ctx, withEstimateCredits(ctx, done));
      return;
    }
    const partial = partialFailure(done);
    if (partial) throw partial;
    // Saved as <file name>-<suffix> unless --name: the server's step name does not say which file it came from.
    const payload = { ...done.payload };
    if (!options.name) delete payload.assetName;
    await deliver(ctx, { ...done, payload }, options, { expectFiles: true, prompt: options.name ?? name });
  } finally {
    activity.stop();
  }
}

function stem(source: string, suffix: string): string {
  return `${sourceStem(source) || 'aitopia'}-${suffix}`;
}

export interface UpscaleOptions extends NamedToolOptions {
  scale?: string;
  resolution?: string;
}

/** aitopia upscale: upscale_image (2x / 4x) or upscale_video (1080p / 2160p), by the file's type. */
export async function upscaleCommand(ctx: Context, source: string, options: UpscaleOptions): Promise<void> {
  checkSource(source, 'image or video to upscale', ['image', 'video'], 'aitopia upscale photo.jpg --scale 4');
  if (options.scale !== undefined && options.scale !== '2' && options.scale !== '4') throw new UsageError(`--scale must be 2 or 4, got "${options.scale}".`);
  if (options.resolution !== undefined && !(UPSCALE_RESOLUTIONS as readonly string[]).includes(options.resolution)) {
    throw new UsageError(`--resolution must be 1080p or 2160p, got "${options.resolution}".`);
  }
  if (options.scale !== undefined && options.resolution !== undefined) {
    throw new UsageError('--scale is for images and --resolution for videos; give one of them.');
  }
  let media = mediaTypeOf(source);
  if (media === 'image' && options.resolution !== undefined) throw new UsageError('--resolution is for videos; an image takes --scale 2 or 4.');
  if (media === 'video' && options.scale !== undefined) throw new UsageError('--scale is for images; a video takes --resolution 1080p or 2160p.');
  checkScopeOptions(options);

  await withSession(ctx, async (session) => {
    const scope = await resolveScope(ctx, session, options); // a missing project stops before the upload
    const assetUrl = await sourceUrl(ctx, session, source);
    if (!media) media = options.resolution !== undefined ? 'video' : options.scale !== undefined ? 'image' : await probeMedia(session, assetUrl, source);
    if (media === 'audio') throw new UsageError(`${source} is audio; upscale takes an image or a video.`);
    if (media === 'image') {
      await runNamed(ctx, session, 'upscale_image', { assetUrl, ...(options.scale ? { scale: Number(options.scale) } : {}) }, scope, options, 'Upscaling the image', stem(source, 'upscaled'));
    } else {
      await runNamed(ctx, session, 'upscale_video', { assetUrl, ...(options.resolution ? { targetResolution: options.resolution } : {}) }, scope, options, 'Upscaling the video', stem(source, 'upscaled'));
    }
  });
}

/** aitopia remove-bg: remove_background (a transparent PNG cut-out). */
export async function removeBgCommand(ctx: Context, source: string, options: NamedToolOptions): Promise<void> {
  checkSource(source, 'image', ['image'], 'aitopia remove-bg product.jpg');
  checkScopeOptions(options);
  await withSession(ctx, async (session) => {
    const scope = await resolveScope(ctx, session, options);
    const assetUrl = await sourceUrl(ctx, session, source);
    await runNamed(ctx, session, 'remove_background', { assetUrl }, scope, options, 'Removing the background', stem(source, 'cutout'));
  });
}

export interface OutpaintOptions extends NamedToolOptions {
  aspect?: string;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  prompt?: string;
}

/** aitopia outpaint: outpaint_image, to an aspect ratio or by pixels per side. */
export async function outpaintCommand(ctx: Context, source: string, options: OutpaintOptions): Promise<void> {
  checkSource(source, 'image', ['image'], 'aitopia outpaint photo.jpg --aspect 16:9');
  const expand = Object.fromEntries((['left', 'right', 'top', 'bottom'] as const).filter((side) => options[side] !== undefined).map((side) => [side, options[side]]));
  const hasExpand = Object.keys(expand).length > 0;
  if (options.aspect === undefined && !hasExpand) throw new UsageError('Say how to extend it: --aspect <ratio>, or pixels per side with --left/--right/--top/--bottom.');
  if (options.aspect !== undefined && hasExpand) throw new UsageError('Give --aspect or pixels per side (--left/--right/--top/--bottom), not both.');
  checkScopeOptions(options);
  await withSession(ctx, async (session) => {
    const scope = await resolveScope(ctx, session, options);
    const assetUrl = await sourceUrl(ctx, session, source);
    const args: Record<string, unknown> = { assetUrl };
    if (options.aspect !== undefined) args.aspectRatio = options.aspect;
    if (hasExpand) args.expand = expand;
    if (options.prompt) args.prompt = options.prompt;
    await runNamed(ctx, session, 'outpaint_image', args, scope, options, 'Extending the image', stem(source, 'outpainted'));
  });
}

export interface ReframeOptions extends NamedToolOptions {
  aspect?: string;
  prompt?: string;
}

/** aitopia reframe: reframe an image or video to another aspect ratio. */
export async function reframeCommand(ctx: Context, source: string, options: ReframeOptions): Promise<void> {
  checkSource(source, 'image or video', ['image', 'video'], 'aitopia reframe clip.mp4 --aspect 9:16');
  if (options.aspect === undefined) throw new UsageError(`--aspect is required, e.g. --aspect 9:16 (${ASPECT_RATIOS.join(', ')}).`);
  checkScopeOptions(options);
  await withSession(ctx, async (session) => {
    const scope = await resolveScope(ctx, session, options);
    const assetUrl = await sourceUrl(ctx, session, source);
    const args: Record<string, unknown> = { assetUrl, aspectRatio: options.aspect };
    if (options.prompt) args.prompt = options.prompt;
    await runNamed(ctx, session, 'reframe', args, scope, options, 'Reframing', stem(source, `${options.aspect?.replace(':', 'x')}`));
  });
}

export interface MotionOptions extends NamedToolOptions {
  prompt?: string;
  mode?: string;
}

/** aitopia motion: motion_control (the character of an image performs a reference video's motion, or replaces its person). */
export async function motionCommand(ctx: Context, character: string, reference: string, options: MotionOptions): Promise<void> {
  checkSource(character, 'character image', ['image'], 'aitopia motion me.png dance.mp4');
  checkSource(reference, 'motion reference video', ['video'], 'aitopia motion me.png dance.mp4');
  checkScopeOptions(options);
  await withSession(ctx, async (session) => {
    const scope = await resolveScope(ctx, session, options);
    const characterImageUrl = await sourceUrl(ctx, session, character);
    const referenceVideoUrl = await sourceUrl(ctx, session, reference);
    const args: Record<string, unknown> = { characterImageUrl, referenceVideoUrl };
    if (options.prompt) args.prompt = options.prompt;
    if (options.mode) args.mode = options.mode;
    await runNamed(ctx, session, 'motion_control', args, scope, options, 'Animating', stem(character, 'motion'));
  });
}

export interface VoiceChangeOptions extends NamedToolOptions {
  voice?: string;
  denoise?: boolean;
}

/** A --voice preset in any case, as the server names it; undefined when it is not one. */
export function voicePreset(value: string): string | undefined {
  const lower = value.trim().toLowerCase();
  return VOICE_PRESETS.find((v) => v.toLowerCase() === lower);
}

/** aitopia voice-change: voice_change (re-voice speech in an audio or video with a preset voice). */
export async function voiceChangeCommand(ctx: Context, source: string, options: VoiceChangeOptions): Promise<void> {
  checkSource(source, 'audio or video', ['audio', 'video'], 'aitopia voice-change take.mp3 --voice Aria');
  let presetVoice: string | undefined;
  if (options.voice !== undefined) {
    presetVoice = voicePreset(options.voice);
    if (!presetVoice) throw new UsageError(`"${options.voice}" is not a preset voice. Choose one of: ${VOICE_PRESETS.join(', ')}.`, 'Your cloned voices speak new text with `aitopia audio "<text>" --voice <name>`.');
  }
  checkScopeOptions(options);
  await withSession(ctx, async (session) => {
    const scope = await resolveScope(ctx, session, options);
    const assetUrl = await sourceUrl(ctx, session, source);
    const args: Record<string, unknown> = { assetUrl };
    if (presetVoice) args.presetVoice = presetVoice;
    if (options.denoise) args.removeBackgroundNoise = true;
    await runNamed(ctx, session, 'voice_change', args, scope, options, 'Changing the voice', stem(source, `${(presetVoice ?? 'voice').toLowerCase()}`));
  });
}
