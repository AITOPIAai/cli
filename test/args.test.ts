import { describe, expect, it } from 'vitest';
import { parseIntegerOption, parseRunArgs, parseSetPair, parseSetPairs } from '../src/args.js';
import { UsageError } from '../src/errors.js';

describe('--set parsing', () => {
  it('parses values as JSON when possible', () => {
    expect(parseSetPair('seed=42')).toEqual(['seed', 42]);
    expect(parseSetPair('loop=true')).toEqual(['loop', true]);
    expect(parseSetPair('tags=["a","b"]')).toEqual(['tags', ['a', 'b']]);
    expect(parseSetPair('opts={"x":1}')).toEqual(['opts', { x: 1 }]);
    expect(parseSetPair('voice=Rachel')).toEqual(['voice', 'Rachel']);
    expect(parseSetPair('text=a=b')).toEqual(['text', 'a=b']);
    expect(parseSetPair('empty=')).toEqual(['empty', '']);
    expect(parseSetPair('quoted="5"')).toEqual(['quoted', '5']);
  });

  it('rejects malformed pairs', () => {
    expect(() => parseSetPair('novalue')).toThrow(UsageError);
    expect(() => parseSetPair('=x')).toThrow(UsageError);
    expect(() => parseSetPair('bad key=1')).toThrow(UsageError);
  });

  it('later keys win', () => {
    expect(parseSetPairs(['a=1', 'a=2', 'b=x'])).toEqual({ a: 2, b: 'x' });
    expect(parseSetPairs(undefined)).toEqual({});
  });
});

describe('run arguments', () => {
  it('accepts --json-args objects and applies --set on top', () => {
    expect(parseRunArgs({ jsonArgs: '{"type":"video","limit":5}', set: ['limit=10'] })).toEqual({ type: 'video', limit: 10 });
  });

  it('reads --args-file, "-" meaning stdin', () => {
    const files: Record<string, string> = { 'args.json': '{"q":"fox"}', '-': '{"from":"stdin"}' };
    const read = (p: string) => {
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return v;
    };
    expect(parseRunArgs({ argsFile: 'args.json' }, read)).toEqual({ q: 'fox' });
    expect(parseRunArgs({ argsFile: '-' }, read)).toEqual({ from: 'stdin' });
    expect(() => parseRunArgs({ argsFile: 'nope.json' }, read)).toThrow(/Cannot read nope.json: ENOENT/);
  });

  it('defaults to {} and rejects bad input with usage errors', () => {
    expect(parseRunArgs({})).toEqual({});
    expect(() => parseRunArgs({ jsonArgs: '{}', argsFile: 'x' })).toThrow(/either/);
    expect(() => parseRunArgs({ jsonArgs: '{bad' })).toThrow(/not valid JSON/);
    expect(() => parseRunArgs({ jsonArgs: '[1,2]' })).toThrow(/JSON object/);
    try {
      parseRunArgs({ jsonArgs: 'null' });
    } catch (error) {
      expect((error as UsageError).exitCode).toBe(2);
    }
  });
});

describe('integer options', () => {
  it('enforces range and whole numbers', () => {
    const count = parseIntegerOption('--count', 1, 4);
    expect(count('3')).toBe(3);
    expect(() => count('0')).toThrow(/between 1 and 4/);
    expect(() => count('5')).toThrow(UsageError);
    expect(() => count('2.5')).toThrow(/whole number/);
    expect(() => count('two')).toThrow(/whole number/);
  });
});
