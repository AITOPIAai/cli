import { joinWords, parseSetPairs } from '../args.js';
import { withSession, type Context } from '../context.js';
import { UsageError } from '../errors.js';
import { checkScopeOptions, resolveScope, resolveVoice } from '../resolve.js';
import type { ToolOutcome } from '../envelope.js';
import { generateAndDeliver, type GenerateOptions } from './generate.js';

/** Moods for --emotion (MiniMax voice_setting.emotion, used by cloned voices). */
export const EMOTIONS = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent'] as const;

export interface AudioOptions extends GenerateOptions {
  /** --voice <name|id>: speak with one of your cloned voices. */
  voice?: string;
  /** --emotion <emotion>: read the text in this mood (speech models that support it). */
  emotion?: string;
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
  if (options.emotion !== undefined && !(EMOTIONS as readonly string[]).includes(options.emotion)) {
    throw new UsageError(`--emotion must be one of: ${EMOTIONS.join(', ')}.`);
  }
  await withSession(ctx, async (session) => {
    const extra: Record<string, unknown> = {};
    if (options.voice !== undefined) {
      const voice = await resolveVoice(session, options.voice);
      extra.voiceId = voice.id;
      if (!ctx.out.jsonMode) ctx.out.note(`Voice: ${voice.name}`);
    }
    if (options.emotion !== undefined) extra.emotion = options.emotion;
    Object.assign(extra, await resolveScope(ctx, session, options));
    // The server says so in `note` when the model does not take the emotion
    // (other notes, like a dry run's "Estimate only", are not repeated).
    const shown = new Set<string>();
    const onAnswer = (outcome: ToolOutcome): void => {
      const note = outcome.payload.note;
      if (options.emotion === undefined || typeof note !== 'string' || !/emotion/i.test(note) || shown.has(note)) return;
      shown.add(note);
      ctx.out.note(`Notice: ${note}`);
    };
    await generateAndDeliver(ctx, session, 'generate_audio', 'audio', prompt, options, extra, 'Generating audio', onAnswer);
  });
}
