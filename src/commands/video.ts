import { joinWords, parseSetPairs } from '../args.js';
import { withSession, type Context } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { allowHttpLoopback, deliver, deliverEstimate, settle, startActivity } from '../results.js';
import { buildVideoInput, findImageField } from '../schema.js';
import { assertLocalFile, isRemoteUrl, uploadSource } from '../upload.js';
import { announceModel, chooseModel, fetchSchema, paidCall, type GenerateOptions } from './generate.js';

/** Stands in for a local start image on --dry-run (the price does not depend on it; nothing is uploaded). */
export const DRY_RUN_IMAGE_URL = 'https://example.invalid/start-image';

export interface VideoOptions extends GenerateOptions {
  image?: string;
  duration?: string;
  aspect?: string;
}

export async function videoCommand(ctx: Context, words: string[], options: VideoOptions): Promise<void> {
  const prompt = joinWords(words);
  if (!prompt) throw new UsageError('A prompt is required, e.g. aitopia video "waves at sunset, slow pan".');
  const sets = parseSetPairs(options.set);
  const { out } = ctx;

  await withSession(ctx, async (session) => {
    const kind = options.image !== undefined ? 'image-to-video' : 'text-to-video';
    const modelId = options.model ?? (await chooseModel(session, kind));
    if (!modelId) {
      throw new CliError(`No ${kind} model is available right now.`, 1, {
        code: 'NO_MODEL',
        hint: 'List models with `aitopia models --type video` and pass one with --model.',
      });
    }
    if (!options.model) announceModel(ctx, modelId);
    const schema = await fetchSchema(session, modelId);

    // Check every flag against the schema before uploading anything.
    const placeholder = options.image !== undefined ? 'https://example.invalid/image' : undefined;
    buildVideoInput(schema, { modelId, prompt, duration: options.duration, aspect: options.aspect, imageUrl: placeholder, sets });

    let imageUrl: string | undefined;
    if (options.image !== undefined) {
      if (isRemoteUrl(options.image)) {
        imageUrl = options.image;
      } else if (options.dryRun) {
        assertLocalFile(options.image);
        imageUrl = DRY_RUN_IMAGE_URL;
      } else {
        out.note(`Uploading ${options.image}...`);
        imageUrl = (await uploadSource(session.callTool, options.image, { allowHttpLoopback: allowHttpLoopback(ctx.serverUrl) })).assetUrl;
      }
      out.debug(`start image field: ${findImageField(schema)}`);
    }

    const input = buildVideoInput(schema, { modelId, prompt, duration: options.duration, aspect: options.aspect, imageUrl, sets });
    const args: Record<string, unknown> = { modelId, input };
    if (options.name) args.assetName = options.name;
    if (options.model) args.allowAnyModel = true;
    if (options.dryRun) args.dryRun = true;

    const activity = startActivity(ctx, options.dryRun ? 'Checking the price' : 'Generating video');
    try {
      const first = await paidCall(options.dryRun, () => session.callTool('run_model', args, { ...activity.callOptions, paid: !options.dryRun }));
      if (options.dryRun) {
        activity.stop();
        deliverEstimate(ctx, first);
        return;
      }
      const done = await settle(ctx, session, first, 'Generating video', activity);
      await deliver(ctx, done, options, { expectFiles: true, prompt: options.name ?? prompt });
    } finally {
      activity.stop();
    }
  });
}
