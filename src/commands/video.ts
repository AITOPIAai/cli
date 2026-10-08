import { joinWords } from '../args.js';
import { withSession, type Context } from '../context.js';
import { isFailed } from '../envelope.js';
import { UsageError } from '../errors.js';
import { allowHttpLoopback } from '../results.js';
import { checkScopeOptions, resolveScope } from '../resolve.js';
import { assertLocalFile, isRemoteUrl, uploadSource } from '../upload.js';
import { announceModel, runToolAndDeliver, type GenerateOptions } from './generate.js';

/** Stands in for a local start image on --dry-run (the price does not depend on it; nothing is uploaded). */
export const DRY_RUN_IMAGE_URL = 'https://example.invalid/start-image';

export interface VideoOptions extends GenerateOptions {
  image?: string;
  duration?: string;
  aspect?: string;
  resolution?: string;
  /** --audio / --no-audio: native sound, on models that make it. */
  audio?: boolean;
}

/** --duration as generate_video takes it: a positive number of seconds. */
export function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.trim().replace(/s$/i, ''));
  if (!value.trim() || !Number.isFinite(n) || n <= 0) throw new UsageError(`--duration must be a number of seconds, e.g. 5, got "${value}".`);
  return n;
}

/**
 * aitopia video: the generate_video tool. AITOPIA picks a fitting video model
 * unless --model is given; a field the model lacks is refused by the server
 * with the allowed values (nothing is spent).
 */
export async function videoCommand(ctx: Context, words: string[], options: VideoOptions): Promise<void> {
  const prompt = joinWords(words);
  if (!prompt) throw new UsageError('A prompt is required, e.g. aitopia video "waves at sunset, slow pan".');
  if (options.set && options.set.length > 0) {
    throw new UsageError('--set is not available for video: it takes --image, --duration, --aspect, --resolution and --audio.',
      'For other model fields run the model directly: aitopia run run_model --set modelId=<id> --set input=\'{"prompt":"..."}\' (fields: `aitopia model <id>`).',
    );
  }
  const duration = parseDuration(options.duration);
  checkScopeOptions(options);
  const { out } = ctx;

  await withSession(ctx, async (session) => {
    // Before anything else: a project that does not exist stops here.
    const scope = await resolveScope(ctx, session, options);

    let imageUrl: string | undefined;
    if (options.image !== undefined) {
      if (isRemoteUrl(options.image)) {
        imageUrl = options.image;
      } else if (options.dryRun) {
        assertLocalFile(options.image);
        imageUrl = DRY_RUN_IMAGE_URL;
      } else {
        out.note(`Uploading ${options.image}...`);
        imageUrl = (await uploadSource(session.callTool, options.image, { cache: session.uploads, allowHttpLoopback: allowHttpLoopback(ctx.serverUrl) })).assetUrl;
      }
    }

    const args: Record<string, unknown> = { prompt, ...scope };
    if (imageUrl) args.imageUrl = imageUrl;
    if (options.model) {
      args.modelId = options.model;
      args.allowAnyModel = true;
    }
    if (duration !== undefined) args.duration = duration;
    if (options.aspect !== undefined) args.aspectRatio = options.aspect;
    if (options.resolution !== undefined) args.resolution = options.resolution;
    if (options.audio !== undefined) args.generateAudio = options.audio;
    if (options.name) args.assetName = options.name;
    if (options.dryRun) args.dryRun = true;

    await runToolAndDeliver(ctx, session, 'generate_video', args, options, 'Generating video', options.name ?? prompt, (first) => {
      // The model AITOPIA picked (when --model was not given).
      const modelId = first.payload.modelId;
      if (!options.model && !isFailed(first) && typeof modelId === 'string' && modelId) announceModel(ctx, modelId);
    });
  });
}
