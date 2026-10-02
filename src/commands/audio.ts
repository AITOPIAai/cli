import { joinWords, parseSetPairs } from '../args.js';
import { withSession, type Context } from '../context.js';
import { UsageError } from '../errors.js';
import { checkScopeOptions, resolveScope, resolveVoice } from '../resolve.js';
import { generateAndDeliver, type GenerateOptions } from './generate.js';

export interface AudioOptions extends GenerateOptions {
  /** --voice <name|id>: speak with one of your cloned voices. */
  voice?: string;
}

export async function audioCommand(ctx: Context, words: string[], options: AudioOptions): Promise<void> {
  const prompt = joinWords(words);
  if (!prompt) throw new UsageError('A prompt or text is required, e.g. aitopia audio "Welcome to AITOPIA."');
  parseSetPairs(options.set);
  checkScopeOptions(options);
  if (options.voice !== undefined && options.model !== undefined) {
    throw new UsageError('--voice speaks with the voice\'s own speech model; leave out --model.');
  }
  if (options.voice !== undefined && !options.voice.trim()) throw new UsageError('--voice needs a voice name or id (see `aitopia voices`).');
  await withSession(ctx, async (session) => {
    const extra: Record<string, unknown> = {};
    if (options.voice !== undefined) {
      const voice = await resolveVoice(session, options.voice);
      extra.voiceId = voice.id;
      if (!ctx.out.jsonMode) ctx.out.note(`Voice: ${voice.name}`);
    }
    Object.assign(extra, await resolveScope(ctx, session, options));
    await generateAndDeliver(ctx, session, 'generate_audio', 'audio', prompt, options, extra, 'Generating audio');
  });
}
