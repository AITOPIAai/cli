import { joinWords, parseSetPairs } from '../args.js';
import { withSession, type Context } from '../context.js';
import { UsageError } from '../errors.js';
import { generateAndDeliver, type GenerateOptions } from './generate.js';

export async function audioCommand(ctx: Context, words: string[], options: GenerateOptions): Promise<void> {
  const prompt = joinWords(words);
  if (!prompt) throw new UsageError('A prompt or text is required, e.g. aitopia audio "Welcome to AITOPIA."');
  parseSetPairs(options.set);
  await withSession(ctx, async (session) => {
    await generateAndDeliver(ctx, session, 'generate_audio', 'audio', prompt, options, {}, 'Generating audio');
  });
}
