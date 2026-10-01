import { readFileSync } from 'node:fs';
import { UsageError } from './errors.js';

const KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** One `--set key=value`: the value is JSON if it parses, else the raw string. */
export function parseSetPair(pair: string): [string, unknown] {
  const eq = pair.indexOf('=');
  if (eq <= 0) throw new UsageError(`--set expects key=value, got "${pair}".`);
  const key = pair.slice(0, eq).trim();
  const raw = pair.slice(eq + 1);
  if (!KEY_PATTERN.test(key)) throw new UsageError(`Invalid field name in --set: "${key}".`);
  return [key, parseLooseValue(raw)];
}

export function parseLooseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

/** All `--set` pairs as an object (a later key wins). */
export function parseSetPairs(pairs: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs ?? []) {
    const [key, value] = parseSetPair(pair);
    out[key] = value;
  }
  return out;
}

/** commander collector for repeatable options. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function parseIntegerOption(name: string, min: number, max: number) {
  return (value: string): number => {
    if (!/^\d+$/.test(value.trim())) throw new UsageError(`${name} must be a whole number, got "${value}".`);
    const n = Number(value);
    if (n < min || n > max) throw new UsageError(`${name} must be between ${min} and ${max}, got ${n}.`);
    return n;
  };
}

function parseObjectJson(text: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`${source} must be a JSON object, like '{"key": "value"}'.`);
  }
  return parsed as Record<string, unknown>;
}

export interface RunArgOptions {
  jsonArgs?: string;
  argsFile?: string;
  set?: string[];
}

/**
 * Arguments of `aitopia run <tool>`: --json-args or --args-file (use "-" for
 * stdin), then --set pairs on top. Nothing given means {}.
 */
export function parseRunArgs(options: RunArgOptions, readFile: (path: string) => string = defaultReadFile): Record<string, unknown> {
  if (options.jsonArgs !== undefined && options.argsFile !== undefined) {
    throw new UsageError('Use either --json-args or --args-file, not both.');
  }
  let args: Record<string, unknown> = {};
  if (options.jsonArgs !== undefined) args = parseObjectJson(options.jsonArgs, '--json-args');
  if (options.argsFile !== undefined) {
    let text: string;
    try {
      text = readFile(options.argsFile);
    } catch (error) {
      throw new UsageError(`Cannot read ${options.argsFile}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
    args = parseObjectJson(text, options.argsFile === '-' ? 'stdin' : options.argsFile);
  }
  return { ...args, ...parseSetPairs(options.set) };
}

function defaultReadFile(path: string): string {
  return readFileSync(path === '-' ? 0 : path, 'utf8');
}

export function joinWords(words: string[] | string | undefined): string {
  const text = (Array.isArray(words) ? words.join(' ') : (words ?? '')).trim();
  return text;
}
