import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  baseNameFor,
  downloadAsset,
  extensionFor,
  resolveOutputTarget,
  sanitizeFileName,
  slugify,
  targetPath,
  uniquePath,
} from '../src/download.js';

describe('sanitizeFileName', () => {
  it('drops directories and traversal', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\Windows\\system32\\evil.dll')).toBe('evil.dll');
    expect(sanitizeFileName('..')).toBe('aitopia');
    expect(sanitizeFileName('/')).toBe('aitopia');
  });

  it('replaces reserved and control characters and leading dots', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
    expect(sanitizeFileName('x\u0000y\nz')).toBe('x_y_z');
    expect(sanitizeFileName('.bashrc')).toBe('bashrc');
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('nul.txt')).toBe('_nul.txt');
  });

  it('limits the length and keeps the extension', () => {
    const name = sanitizeFileName(`${'a'.repeat(300)}.png`);
    expect(name.length).toBe(120);
    expect(name.endsWith('.png')).toBe(true);
  });
});

describe('extensionFor', () => {
  it('prefers Content-Type, then the URL, then bin', () => {
    expect(extensionFor('image/png; charset=binary', 'https://x/y.jpg')).toBe('png');
    expect(extensionFor('application/octet-stream', 'https://cdn.aitopia.ai/a/b.mp4?sig=1')).toBe('mp4');
    expect(extensionFor(null, 'https://cdn.aitopia.ai/a/b')).toBe('bin');
    expect(extensionFor('audio/mpeg')).toBe('mp3');
    expect(extensionFor('video/quicktime')).toBe('mov');
  });

  it('only uses allowlisted media extensions', () => {
    expect(extensionFor('text/html', 'https://x/page.html')).toBe('bin');
    expect(extensionFor('image/svg+xml', 'https://x/a.svg')).toBe('bin');
    expect(extensionFor('application/x-msdownload', 'https://x/setup.exe')).toBe('bin');
    expect(extensionFor(null, 'https://x/run.sh')).toBe('bin');
    expect(extensionFor(null, 'https://x/subs.srt')).toBe('srt');
  });
});

describe('slugify', () => {
  it('makes lowercase ascii words joined by "-", cut at a word boundary', () => {
    expect(slugify('a small paper boat on calm…')).toBe('a-small-paper-boat-on-calm');
    expect(slugify('Crème Brûlée, 4K!')).toBe('creme-brulee-4k');
    const long = slugify('the quick brown fox jumps over the lazy dog near the riverbank at dawn');
    expect(long).toBe('the-quick-brown-fox-jumps-over-the-lazy-dog-near');
    expect(long.length).toBeLessThanOrEqual(48);
    expect(slugify('x'.repeat(80))).toHaveLength(48);
    expect(slugify('日本語')).toBe('');
    expect(slugify(undefined)).toBe('');
  });
});

describe('naming', () => {
  it('slugs the asset name, else the prompt, else "aitopia"', () => {
    expect(baseNameFor('Red Fox', 'ignored prompt')).toBe('red-fox');
    expect(baseNameFor('a small paper boat on calm….png')).toBe('a-small-paper-boat-on-calm');
    expect(baseNameFor('a small paper boat on calm…', 'a small paper boat on calm water')).toBe('a-small-paper-boat-on-calm-water');
    expect(baseNameFor(undefined, 'the fox blinks')).toBe('the-fox-blinks');
    expect(baseNameFor('../../etc/passwd')).toBe('etc-passwd');
    expect(baseNameFor(undefined, undefined)).toBe('aitopia');
  });

  it('numbers batch results in a directory', () => {
    const dirTarget = { kind: 'dir' as const, path: '/o' };
    expect(targetPath(dirTarget, { url: 'https://c/1.png', assetName: 'Boat', index: 0, total: 3, contentType: 'image/png' })).toBe(join('/o', 'boat-1.png'));
    expect(targetPath(dirTarget, { url: 'https://c/3.png', assetName: 'Boat', index: 2, total: 3, contentType: 'image/png' })).toBe(join('/o', 'boat-3.png'));
    expect(targetPath(dirTarget, { url: 'https://c/5a19fd89_output_0.mp4', fallbackName: 'Waves at sunset', index: 0, total: 1 })).toBe(join('/o', 'waves-at-sunset.mp4'));
  });

  it('adds -1, -2 until a free name is found; --force keeps the name', () => {
    const taken = new Set(['/o/fox.png', '/o/fox-1.png']);
    const exists = (p: string) => taken.has(p);
    expect(uniquePath('/o/fox.png', false, exists)).toBe('/o/fox-2.png');
    expect(uniquePath('/o/fox.png', true, exists)).toBe('/o/fox.png');
    expect(uniquePath('/o/new.png', false, exists)).toBe('/o/new.png');
  });

  it('numbers files when -o is a file and there are several', () => {
    const target = { kind: 'file' as const, path: '/o/logo' };
    expect(targetPath(target, { url: 'https://c/x.png', index: 0, total: 3, contentType: 'image/png' })).toBe('/o/logo-1.png');
    expect(targetPath(target, { url: 'https://c/x.png', index: 2, total: 3, contentType: 'image/png' })).toBe('/o/logo-3.png');
    expect(targetPath({ kind: 'file', path: '/o/me.webp' }, { url: 'https://c/x.png', index: 0, total: 1 })).toBe('/o/me.webp');
  });
});

describe('downloadAsset', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aitopia-dl-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fakeFetch = (body: string, type = 'image/png') =>
    (async () => new Response(body, { status: 200, headers: { 'content-type': type } })) as unknown as typeof fetch;

  it('streams to a file named from the asset, never overwriting without --force', async () => {
    const target = resolveOutputTarget(dir);
    expect(target.kind).toBe('dir');
    const url = 'https://cdn.aitopia.ai/u/abc.png';
    const first = await downloadAsset(url, { target, index: 0, total: 1, assetName: 'fox', force: false, fetchFn: fakeFetch('one') });
    const second = await downloadAsset(url, { target, index: 0, total: 1, assetName: 'fox', force: false, fetchFn: fakeFetch('two') });
    expect(first).toBe(join(dir, 'fox.png'));
    expect(second).toBe(join(dir, 'fox-1.png'));
    expect(readFileSync(first, 'utf8')).toBe('one');
    expect(readFileSync(second, 'utf8')).toBe('two');

    const forced = await downloadAsset(url, { target, index: 0, total: 1, assetName: 'fox', force: true, fetchFn: fakeFetch('three') });
    expect(forced).toBe(first);
    expect(readFileSync(first, 'utf8')).toBe('three');
    // No temp files are left behind.
    expect(readdirSync(dir).sort()).toEqual(['fox-1.png', 'fox.png']);
  });

  it('keeps a hostile asset name inside the output directory', async () => {
    const out = join(dir, 'out');
    mkdirSync(out);
    const path = await downloadAsset('https://cdn.aitopia.ai/x.png', {
      target: resolveOutputTarget(out),
      index: 0,
      total: 1,
      assetName: '../../escape',
      force: false,
      fetchFn: fakeFetch('x'),
    });
    expect(path).toBe(join(out, 'escape.png'));
  });

  it('follows redirects manually and re-checks every hop', async () => {
    const target = resolveOutputTarget(dir);
    const seen: Array<{ url: string; redirect?: string }> = [];
    const redirecting = (hops: Record<string, string>) =>
      (async (url: string, init: RequestInit) => {
        seen.push({ url, redirect: init.redirect });
        const next = hops[url];
        if (next) return new Response(null, { status: 302, headers: { location: next } });
        return new Response('final', { status: 200, headers: { 'content-type': 'video/mp4' } });
      }) as unknown as typeof fetch;

    const path = await downloadAsset('https://cdn.aitopia.ai/a', {
      target, index: 0, total: 1, assetName: 'clip', force: false,
      fetchFn: redirecting({ 'https://cdn.aitopia.ai/a': '/b', 'https://cdn.aitopia.ai/b': 'https://storage.example.com/c' }),
    });
    expect(readFileSync(path, 'utf8')).toBe('final');
    expect(seen.map((s) => s.url)).toEqual(['https://cdn.aitopia.ai/a', 'https://cdn.aitopia.ai/b', 'https://storage.example.com/c']);
    expect(seen.every((s) => s.redirect === 'manual')).toBe(true);

    await expect(
      downloadAsset('https://cdn.aitopia.ai/a', {
        target, index: 0, total: 1, force: false,
        fetchFn: redirecting({ 'https://cdn.aitopia.ai/a': 'http://169.254.169.254/latest/meta-data' }),
      }),
    ).rejects.toThrow(/non-https/);

    const loop: Record<string, string> = {};
    for (let i = 0; i < 10; i++) loop[`https://cdn.aitopia.ai/${i}`] = `https://cdn.aitopia.ai/${i + 1}`;
    await expect(
      downloadAsset('https://cdn.aitopia.ai/0', { target, index: 0, total: 1, force: false, fetchFn: redirecting(loop) }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('allows http only to loopback and only when enabled', async () => {
    const target = resolveOutputTarget(dir);
    const opts = { target, index: 0, total: 1, force: false, fetchFn: fakeFetch('x') };
    await expect(downloadAsset('http://127.0.0.1:9/x.png', opts)).rejects.toThrow(/non-https/);
    await expect(downloadAsset('http://127.0.0.1:9/x.png', { ...opts, allowHttpLoopback: true })).resolves.toContain('aitopia.png');
    await expect(downloadAsset('http://example.com/x.png', { ...opts, allowHttpLoopback: true })).rejects.toThrow(/non-https/);
  });

  it('stops at the byte cap and leaves no partial file', async () => {
    const target = resolveOutputTarget(dir);
    await expect(
      downloadAsset('https://cdn.aitopia.ai/big.png', { target, index: 0, total: 1, force: false, fetchFn: fakeFetch('0123456789'), maxBytes: 4 }),
    ).rejects.toThrow(/stopped at 4 bytes/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('stops a download that goes idle', async () => {
    const target = resolveOutputTarget(dir);
    const stalled = (async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    await expect(
      downloadAsset('https://cdn.aitopia.ai/slow.png', { target, index: 0, total: 1, force: false, fetchFn: stalled, idleTimeoutMs: 50 }),
    ).rejects.toThrow(/stalled/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes to an explicit file path and adds a suffix if it exists', async () => {
    const file = join(dir, 'result.png');
    writeFileSync(file, 'old');
    const target = resolveOutputTarget(file);
    expect(target.kind).toBe('file');
    const path = await downloadAsset('https://cdn.aitopia.ai/x.png', { target, index: 0, total: 1, force: false, fetchFn: fakeFetch('new') });
    expect(path).toBe(join(dir, 'result-1.png'));
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it('refuses non-https URLs and failed responses', async () => {
    const target = resolveOutputTarget(dir);
    await expect(
      downloadAsset('http://example.com/x.png', { target, index: 0, total: 1, force: false, fetchFn: fakeFetch('x') }),
    ).rejects.toThrow(/non-https/);
    const notFound = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    await expect(
      downloadAsset('https://cdn.aitopia.ai/x.png', { target, index: 0, total: 1, force: false, fetchFn: notFound }),
    ).rejects.toThrow(/HTTP 404/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
