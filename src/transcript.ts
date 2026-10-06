// Speech-to-text results: reading the model output and building SRT cues.
// The CLI runs the speech models itself through run_model (not a transcribe
// tool). Its model choice, language handling and 2-hour limit follow the
// server's speech-to-text rules (scotty src/lib/creator/transcribe.ts), and so
// do its cues: at most 2 lines of 42 characters and 3.5 s, broken after
// sentence punctuation or on a pause longer than 0.6 s.

export const GROK_STT_MODEL = 'xai/grok-speech-to-text';
export const WHISPER_STT_MODEL = 'openai/whisper';

/** Languages Grok Speech-to-Text takes (its model schema); any other one runs Whisper. */
export const GROK_LANGUAGES = new Set([
  'ar', 'cs', 'da', 'de', 'en', 'es', 'fa', 'fil', 'fr', 'hi', 'id', 'it', 'ja',
  'ko', 'mk', 'ms', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'vi',
]);

export const CUE_MAX_LINE_CHARS = 42;
export const CUE_MAX_CHARS = CUE_MAX_LINE_CHARS * 2;
export const CUE_MAX_SECONDS = 3.5;
export const CUE_PAUSE_SECONDS = 0.6;

export interface TimedText {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  language?: string;
  durationSec?: number;
  /** Word timings (Grok); empty for Whisper. */
  words: TimedText[];
  /** Segments as the model gave them (Whisper); empty for Grok. */
  segments: TimedText[];
}

/** Longest media transcribed in one run (the server's limit): 2 hours. */
export const MAX_TRANSCRIBE_SECONDS = 2 * 60 * 60;

/**
 * A --language as the models take it: a code in lower case without its region
 * ("pt-BR" -> "pt", "EN" -> "en"); a name ("English", for Whisper) as written.
 * "auto" (any case) means detect it: no language is sent.
 */
export function normalizeLanguage(language: string | undefined): string | undefined {
  const value = language?.trim();
  if (!value || value.toLowerCase() === 'auto') return undefined;
  const code = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*$/i.exec(value);
  return code ? (code[1] as string).toLowerCase() : value;
}

/** The speech-to-text model for a --language: Grok for its 25 languages (and none given), else Whisper. */
export function sttModelFor(language: string | undefined): string {
  const lang = normalizeLanguage(language);
  return lang === undefined || GROK_LANGUAGES.has(lang.toLowerCase()) ? GROK_STT_MODEL : WHISPER_STT_MODEL;
}

/** run_model input for the model. */
export function sttInput(modelId: string, audioUrl: string, language: string | undefined): Record<string, unknown> {
  const lang = normalizeLanguage(language);
  if (modelId === WHISPER_STT_MODEL) return { audio: audioUrl, transcription: 'srt', ...(lang ? { language: lang } : {}) };
  return { audio: audioUrl, timestamps: true, ...(lang ? { language: lang } : {}) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function seconds(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function timed(value: unknown, textKeys: string[]): TimedText | undefined {
  if (!isObject(value)) return undefined;
  const key = textKeys.find((k) => typeof value[k] === 'string');
  const text = key ? clean(value[key] as string) : '';
  const start = seconds(value.start);
  if (!text || start === undefined) return undefined;
  const end = seconds(value.end);
  return { start, end: end !== undefined && end >= start ? end : start, text };
}

function looksLikeSrt(text: string): boolean {
  return /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(text);
}

function srtTime(value: string): number {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] ?? '0').padEnd(3, '0')) / 1000;
}

/** Cues of an SRT text. */
export function parseSrt(srt: string): TimedText[] {
  const cues: TimedText[] = [];
  for (const block of srt.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [rawStart = '', rawEnd = ''] = (lines[at] as string).split('-->');
    const start = srtTime(rawStart);
    const end = srtTime(rawEnd.trim().split(/\s+/)[0] ?? '');
    const text = clean(lines.slice(at + 1).join(' '));
    if (!Number.isFinite(start) || !text) continue;
    cues.push({ start, end: Number.isFinite(end) && end >= start ? end : start, text });
  }
  return cues;
}

/**
 * Reads a run_model output: Grok {text, language, duration, words:[{text,start,end}]}
 * or Whisper {detected_language, segments:[{start,end,text}], transcription}.
 */
export function parseTranscript(output: unknown): Transcript {
  let o = isObject(output) ? output : {};
  // Some runs wrap the model's answer once more ({output: {...}}).
  for (let depth = 0; depth < 2 && isObject(o.output) && o.text === undefined && o.words === undefined && o.segments === undefined; depth++) {
    o = o.output as Record<string, unknown>;
  }
  const words = (Array.isArray(o.words) ? o.words : []).map((w) => timed(w, ['text', 'word'])).filter((w): w is TimedText => Boolean(w));
  let segments = (Array.isArray(o.segments) ? o.segments : []).map((s) => timed(s, ['text'])).filter((s): s is TimedText => Boolean(s));
  const transcription = typeof o.transcription === 'string' ? o.transcription : undefined;
  if (segments.length === 0 && transcription && looksLikeSrt(transcription)) segments = parseSrt(transcription);
  let text = typeof o.text === 'string' ? o.text.trim() : '';
  if (!text && transcription && !looksLikeSrt(transcription)) text = transcription.trim();
  if (!text && typeof output === 'string') text = output.trim();
  const language = typeof o.language === 'string' ? o.language : typeof o.detected_language === 'string' ? o.detected_language : undefined;
  if (!text) {
    const tokens = words.length > 0 ? words : segments;
    text = joinWords(tokens, usesNoSpaces(language, tokens));
  }
  const durationSec = seconds(o.duration);
  return { text, ...(language ? { language } : {}), ...(durationSec !== undefined ? { durationSec } : {}), words, segments };
}

/** Japanese, Chinese and Thai text has no spaces between words. */
const NO_SPACE_SCRIPT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\u0e00-\u0e7f]/;
const NO_SPACE_LANGUAGES = /^(ja|zh|th|yue|japanese|chinese|mandarin|cantonese|thai)\b/i;

/** Whether tokens are joined without spaces: from the language, else from the script of the text. */
export function usesNoSpaces(language: string | undefined, tokens: TimedText[]): boolean {
  if (language && NO_SPACE_LANGUAGES.test(language.trim())) return true;
  return tokens.some((t) => NO_SPACE_SCRIPT.test(t.text));
}

function joinWords(words: TimedText[], noSpaces = false): string {
  if (noSpaces) return words.map((w) => w.text.trim()).join('');
  return words.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1');
}

const SENTENCE_END = /[.!?…。！？]["')\]」』）]?$/;
const CLAUSE_END = /[,;:、，；：]["')\]」』）]?$/;

/**
 * Groups word timings into caption cues: a new cue starts on a pause over
 * 0.6 s, when the cue would pass two lines (84 characters) or 3.5 s, after
 * sentence punctuation, and after a comma once the cue fills a line.
 */
export function cuesFromWords(words: TimedText[], noSpaces = usesNoSpaces(undefined, words)): TimedText[] {
  const cues: TimedText[] = [];
  let current: TimedText[] = [];
  const join = (list: TimedText[]) => joinWords(list, noSpaces);
  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last) cues.push({ start: first.start, end: last.end, text: join(current) });
    current = [];
  };
  for (const word of words) {
    const first = current[0];
    const previous = current[current.length - 1];
    if (
      first &&
      previous &&
      (word.start - previous.end > CUE_PAUSE_SECONDS ||
        join([...current, word]).length > CUE_MAX_CHARS ||
        word.end - first.start > CUE_MAX_SECONDS)
    ) {
      flush();
    }
    current.push(word);
    if (SENTENCE_END.test(word.text)) flush();
    else if (CLAUSE_END.test(word.text) && join(current).length >= CUE_MAX_LINE_CHARS) flush();
  }
  flush();
  return cues;
}

/** Lines of at most `max` characters: at spaces where possible, a longer word is cut. */
function greedyLines(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    let rest = word;
    while (rest.length > max) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    if (!rest) continue;
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= max) line = `${line} ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Cue text in lines of at most 42 characters: one line when it fits, else two
 * split at the space that best balances them (both within 42). When no space
 * allows that, the text is cut at 42 characters (two lines up to 84
 * characters; longer text gets more lines).
 */
export function wrapCue(raw: string): string {
  const text = clean(raw);
  if (text.length <= CUE_MAX_LINE_CHARS) return text;
  let best = -1;
  for (let i = text.indexOf(' '); i >= 0; i = text.indexOf(' ', i + 1)) {
    if (i > CUE_MAX_LINE_CHARS || text.length - i - 1 > CUE_MAX_LINE_CHARS) continue;
    if (best < 0 || Math.abs(text.length / 2 - i) < Math.abs(text.length / 2 - best)) best = i;
  }
  if (best >= 0) return `${text.slice(0, best)}\n${text.slice(best + 1)}`;
  if (text.length <= CUE_MAX_CHARS) return `${text.slice(0, CUE_MAX_LINE_CHARS).trimEnd()}\n${text.slice(CUE_MAX_LINE_CHARS).trimStart()}`;
  return greedyLines(text, CUE_MAX_LINE_CHARS).join('\n');
}

/**
 * A model segment longer than a cue (84 characters or 3.5 s) split into
 * several cues; each piece gets a share of the segment's time by its length.
 */
export function splitSegment(segment: TimedText, noSpaces = usesNoSpaces(undefined, [segment])): TimedText[] {
  const text = clean(segment.text);
  const duration = Math.max(0, segment.end - segment.start);
  if (text.length <= CUE_MAX_CHARS && duration <= CUE_MAX_SECONDS) return [{ ...segment, text }];
  const tokens = noSpaces ? Array.from(text.replace(/\s+/g, '')) : text.split(' ').flatMap((w) => greedyLines(w, CUE_MAX_LINE_CHARS));
  const sep = noSpaces ? '' : ' ';
  const total = tokens.join(sep).length || 1;
  const timed = (texts: string[]): TimedText[] => {
    let before = 0;
    return texts.map((piece) => {
      const start = segment.start + (duration * before) / total;
      before += piece.length + sep.length;
      return { start, end: Math.min(segment.end, segment.start + (duration * Math.min(before, total)) / total), text: piece };
    });
  };
  // Fewest pieces of about equal length that fit a cue (84 characters, 3.5 s);
  // a single token longer than that stays one cue.
  let best: TimedText[] = [{ ...segment, text }];
  const first = Math.max(Math.ceil(text.length / CUE_MAX_CHARS), Math.ceil(duration / CUE_MAX_SECONDS), 2);
  for (let pieces = Math.min(first, tokens.length); pieces <= tokens.length; pieces++) {
    const target = total / pieces;
    const groups: string[][] = [];
    let group: string[] = [];
    let used = 0;
    for (const token of tokens) {
      const next = [...group, token].join(sep).length;
      const boundary = used + next > target * (groups.length + 1) + target / 2;
      if (group.length > 0 && (next > CUE_MAX_CHARS || (boundary && groups.length < pieces - 1))) {
        used += group.join(sep).length + sep.length;
        groups.push(group);
        group = [];
      }
      group.push(token);
    }
    if (group.length > 0) groups.push(group);
    best = timed(groups.map((g) => g.join(sep)));
    if (best.every((c) => c.end - c.start <= CUE_MAX_SECONDS + 1e-6 && c.text.length <= CUE_MAX_CHARS)) break;
  }
  return best;
}

export function srtTimestamp(secondsValue: number): string {
  const total = Math.max(0, Math.round(secondsValue * 1000));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor((total % 3_600_000) / 60_000))}:${pad(Math.floor((total % 60_000) / 1000))},${pad(total % 1000, 3)}`;
}

/**
 * SRT text of the cues. A zero-length cue is held for half a second so players
 * show it, but never past the start of the next cue.
 */
export function buildSrt(cues: TimedText[]): string {
  const list = cues.filter((c) => clean(c.text));
  return list
    .map((c, i) => {
      let end = c.end;
      if (end <= c.start) {
        end = c.start + 0.5;
        const next = list[i + 1];
        if (next && next.start > c.start) end = Math.min(end, next.start);
      }
      return `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(end)}\n${wrapCue(c.text)}\n`;
    })
    .join('\n');
}

/** The cues of a transcript: one per word with `perWord`, grouped words, else the model's segments. */
export function cuesOf(transcript: Transcript, perWord = false): TimedText[] {
  const tokens = transcript.words.length > 0 ? transcript.words : transcript.segments;
  const noSpaces = usesNoSpaces(transcript.language, tokens);
  if (transcript.words.length > 0) return perWord ? transcript.words : cuesFromWords(transcript.words, noSpaces);
  return transcript.segments.flatMap((segment) => splitSegment(segment, noSpaces));
}
