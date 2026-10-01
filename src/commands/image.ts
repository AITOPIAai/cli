import { joinWords, parseSetPairs } from '../args.js';
import { withSession, type Context } from '../context.js';
import { UsageError } from '../errors.js';
import { generateAndDeliver, type GenerateOptions } from './generate.js';

export interface ImageOptions extends GenerateOptions {
  aspect?: string;
  count?: number;
}

export async function imageCommand(ctx: Context, words: string[], options: ImageOptions): Promise<void> {
  const prompt = joinWords(words);
  if (!prompt) throw new UsageError('A prompt is required, e.g. aitopia image "a red fox in snow".');
  parseSetPairs(options.set); // fail on bad --set before connecting
  await withSession(ctx, async (session) => {
    const extra = options.count && options.count > 1 ? { count: options.count } : {};
    await generateAndDeliver(ctx, session, 'generate_image', 'image', prompt, options, extra, 'Generating image');
  });
}
