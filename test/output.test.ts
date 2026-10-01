import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { Output, describeProgress, formatEta, palette, progressMessage, renderForTerminal, safeJson, stripControl } from '../src/output.js';
import { isSafeBrowserUrl } from '../src/auth.js';
import { creditsLine } from '../src/commands/credits.js';

class Capture extends Writable {
  text = '';
  isTTY = true;
  override _write(chunk: Buffer, _enc: string, done: () => void) {
    this.text += chunk.toString();
    done();
  }
}

describe('terminal safety', () => {
  it('strips CSI, OSC and other control characters but keeps newlines and tabs', () => {
    expect(stripControl('a\u001b[31mred\u001b[0m b')).toBe('ared b');
    expect(stripControl('x\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007y')).toBe('xlinky');
    expect(stripControl('title\u001b]0;pwned\u001b\\ok')).toBe('titleok');
    expect(stripControl('bell\u0007 cr\r back\b c1\u009b31m')).toBe('bell cr back c131m');
    expect(stripControl('line1\n\tline2')).toBe('line1\n\tline2');
  });

  it('keeps our own colors and removes injected ones', () => {
    const p = palette(true);
    const text = `${p.green('Saved')} evil\u001b[2J\u001b[31m.png`;
    expect(renderForTerminal(text)).toBe('\u001b[32mSaved\u001b[39m evil.png');
  });

  it('never writes server escape sequences through Output', () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const out = new Output({ stdout, stderr, env: {} });
    out.line(`${out.out.green('Saved')} \u001b]52;c;ZXZpbA==\u0007file.png`);
    out.note('hint \u001b[1Aup');
    expect(stdout.text).toBe('\u001b[32mSaved\u001b[39m file.png\n');
    expect(stderr.text).toBe('hint up\n');
  });

  it('respects NO_COLOR', () => {
    const stdout = new Capture();
    const out = new Output({ stdout, stderr: new Capture(), env: { NO_COLOR: '1' } });
    out.line(out.out.green('Saved'));
    expect(stdout.text).toBe('Saved\n');
  });

  it('escapes C1 controls in JSON output', () => {
    expect(safeJson({ a: 'x\u009b31my' })).toContain('\\u009b');
    expect(JSON.parse(safeJson({ a: 'x\u009by' }))).toEqual({ a: 'x\u009by' });
  });
});

describe('browser links', () => {
  it('opens only https, or http to loopback', () => {
    expect(isSafeBrowserUrl('https://mcp.aitopia.ai/authorize?x=1')).toBe(true);
    expect(isSafeBrowserUrl('http://127.0.0.1:5000/authorize')).toBe(true);
    expect(isSafeBrowserUrl('http://mcp.aitopia.ai/authorize')).toBe(false);
    expect(isSafeBrowserUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeBrowserUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('creditsLine', () => {
  it('uses creditsForGeneration first', () => {
    expect(creditsLine({ creditsForGeneration: 8951, totalCredits: -999, unlimited: true })).toBe('Credits: 8,951 available');
    expect(creditsLine({ creditsForGeneration: 'unlimited', totalCredits: 5 })).toBe('Credits: unlimited');
    expect(creditsLine({ creditsForGeneration: 120, totalCredits: 120, paidCreditsBalance: 100, dailyCreditsRemaining: 20 })).toBe(
      'Credits: 120 available (100 paid, 20 daily left)',
    );
  });

  it('falls back to the account flags only without creditsForGeneration', () => {
    expect(creditsLine({ totalCredits: -999, unlimited: true })).toBe('Credits: unlimited');
    expect(creditsLine({ totalCredits: 42 })).toBe('Credits: 42 available');
    expect(creditsLine({})).toBe('Credits: unknown');
  });
});

describe('progress text', () => {
  it('formats the ETA as ~N s / ~N min left', () => {
    expect(formatEta(undefined)).toBe('');
    expect(formatEta(0)).toBe('');
    expect(formatEta(42.4)).toBe('~42 s left');
    expect(formatEta(300)).toBe('~5 min left');
    expect(describeProgress({ progress: 40, etaSeconds: 20 })).toBe('40%, ~20 s left');
    expect(describeProgress({ progress: 40, etaSeconds: 20 }, { eta: false })).toBe('40%');
  });

  it("drops the server's own seconds counter and control characters", () => {
    expect(progressMessage('Generating image with GPT Image 2.5 — 9 s')).toBe('Generating image with GPT Image 2.5');
    expect(progressMessage('Running 5 generations, 2 done — 12 s')).toBe('Running 5 generations, 2 done');
    expect(progressMessage('evil\u001b[31m red')).toBe('evil red');
    expect(progressMessage(undefined)).toBe('');
  });

  it('a TTY spinner shows the new label and counts the ETA down', () => {
    vi.useFakeTimers();
    try {
      const stderr = new Capture();
      const out = new Output({ stdout: new Capture(), stderr, env: { NO_COLOR: '1' } });
      let t = 0;
      const spinner = out.spinner('Generating image', () => t);
      spinner.setLabel('Generating image with Nano Banana 2');
      spinner.setEta(30);
      t = 10_000;
      vi.advanceTimersByTime(120);
      expect(stderr.text).toContain('Generating image with Nano Banana 2 10s - ~20 s left');
      spinner.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
