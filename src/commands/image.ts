import { joinWords, parseSetPairs } from '../args.js';
import { withSession, type Context } from '../context.js';
import { UsageError } from '../errors.js';
import { checkScopeOptions, resolveScope } from '../resolve.js';
import { generateAndDeliver, type GenerateOptions } from './generate.js';

export interface ImageOptions extends GenerateOptions {
  aspect?: string;
  count?: number;
}

export async function imageCommand(ctx: Context, words: string[], options: ImageOptions): Promise<void> {
  const prompt = joinWords(words);
  if (!prompt) throw new UsageError('A prompt is required, e.g. aitopia image "a red fox in snow".');
  parseSetPairs(options.set); // fail on bad --set before connecting
  checkScopeOptions(options);
  await withSession(ctx, async (session) => {
    // Before the paid call: a project that does not exist stops here.
    const scope = await resolveScope(ctx, session, options);
    const extra = { ...(options.count && options.count > 1 ? { count: options.count } : {}), ...scope };
    await generateAndDeliver(ctx, session, 'generate_image', 'image', prompt, options, extra, 'Generating image');
  });
}
