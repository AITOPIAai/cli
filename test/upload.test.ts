import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolOutcome } from '../src/envelope.js';
import { INLINE_UPLOAD_MAX_BYTES, retryAfterMs, uploadSource } from '../src/upload.js';

const ok = (payload: Record<string, unknown>): ToolOutcome => ({ payload, isError: false, links: [] });

describe('uploadSource', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aitopia-up-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sends small files inline as base64 via upload_asset', async () => {
    const file = join(dir, 'tiny.png');
    writeFileSync(file, Buffer.from('png-bytes'));
    const call = vi.fn().mockResolvedValue(ok({ status: 'completed', assetUrl: 'https://cdn.aitopia.ai/tiny.png' }));
    const result = await uploadSource(call, file);
    expect(result.assetUrl).toBe('https://cdn.aitopia.ai/tiny.png');
    expect(call).toHaveBeenCalledWith('upload_asset', { fileName: 'tiny.png', contentBase64: Buffer.from('png-bytes').toString('base64') });
  });

  it('streams larger files with a PUT to a single-use link', async () => {
    const file = join(dir, 'big clip.mp4');
    writeFileSync(file, Buffer.alloc(INLINE_UPLOAD_MAX_BYTES + 1, 1));
    const call = vi.fn().mockResolvedValue(
      ok({ status: 'link_created', uploadUrl: 'https://mcp.aitopia.ai/u/abc', method: 'PUT', maxBytes: 95 * 1024 * 1024 }),
    );
    let seen: { method?: string; headers?: Record<string, string>; bytes?: number } = {};
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = await new Response(init.body).arrayBuffer();
      seen = { method: init.method, headers: init.headers as Record<string, string>, bytes: body.byteLength };
      return new Response(JSON.stringify({ assetUrl: 'https://cdn.aitopia.ai/big.mp4' }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await uploadSource(call, file, { fetchFn });
    expect(call).toHaveBeenCalledWith('create_upload_link', { fileName: 'big clip.mp4', contentType: 'video/mp4' });
    expect(seen.method).toBe('PUT');
    expect(seen.headers?.['X-File-Name']).toBe('big%20clip.mp4');
    expect(seen.bytes).toBe(INLINE_UPLOAD_MAX_BYTES + 1);
    expect(result.assetUrl).toBe('https://cdn.aitopia.ai/big.mp4');
  });

  it('asks for the upload link with the project and folder when a scope is given', async () => {
    const file = join(dir, 'big.mp4');
    writeFileSync(file, Buffer.alloc(INLINE_UPLOAD_MAX_BYTES + 1, 1));
    const call = vi.fn().mockResolvedValue(ok({ status: 'link_created', uploadUrl: 'https://mcp.aitopia.ai/u/abc', maxBytes: 95 * 1024 * 1024 }));
    const fetchFn = (async () => new Response(JSON.stringify({ assetUrl: 'https://cdn.aitopia.ai/big.mp4' }), { status: 200 })) as unknown as typeof fetch;
    await uploadSource(call, file, { fetchFn, scope: { projectId: 'p-1', folderId: 'f-1' } });
    expect(call).toHaveBeenCalledWith('create_upload_link', { fileName: 'big.mp4', contentType: 'video/mp4', projectId: 'p-1', folderId: 'f-1' });
  });

  it('refuses a file above maxBytes before uploading', async () => {
    const file = join(dir, 'huge.mov');
    writeFileSync(file, Buffer.alloc(200 * 1024));
    const call = vi.fn().mockResolvedValue(ok({ status: 'link_created', uploadUrl: 'https://mcp.aitopia.ai/u/abc', maxBytes: 150 * 1024 }));
    const fetchFn = vi.fn();
    await expect(uploadSource(call, file, { fetchFn: fetchFn as unknown as typeof fetch })).rejects.toThrow(/upload limit is 150.0 KB/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('imports URLs through create_upload_link sourceUrl', async () => {
    const call = vi.fn().mockResolvedValue(ok({ status: 'completed', assetUrl: 'https://cdn.aitopia.ai/imported.jpg' }));
    const result = await uploadSource(call, 'https://example.com/photo.jpg');
    expect(call).toHaveBeenCalledWith('create_upload_link', { sourceUrl: 'https://example.com/photo.jpg' });
    expect(result.assetUrl).toBe('https://cdn.aitopia.ai/imported.jpg');
  });

  it('rejects missing and empty files as usage errors', async () => {
    const call = vi.fn();
    await expect(uploadSource(call, join(dir, 'nope.png'))).rejects.toMatchObject({ exitCode: 2 });
    const empty = join(dir, 'empty.png');
    writeFileSync(empty, '');
    await expect(uploadSource(call, empty)).rejects.toThrow(/empty/);
    expect(call).not.toHaveBeenCalled();
  });

  it('retries a PUT answered 429 with the same link, honoring Retry-After, at most 3 times', async () => {
    const file = join(dir, 'clip.mp4');
    writeFileSync(file, Buffer.alloc(INLINE_UPLOAD_MAX_BYTES + 10, 2));
    const call = vi.fn().mockResolvedValue(ok({ status: 'link_created', uploadUrl: 'https://mcp.aitopia.ai/u/one', maxBytes: 95 * 1024 * 1024 }));
    const sizes: number[] = [];
    let answers = [429, 429, 200];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sizes.push((await new Response(init.body).arrayBuffer()).byteLength);
      const status = answers.shift() ?? 429;
      if (status === 429) return new Response('slow down', { status, headers: { 'retry-after': '1' } });
      return new Response(JSON.stringify({ assetUrl: 'https://cdn.aitopia.ai/clip.mp4' }), { status: 200 });
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    await expect(uploadSource(call, file, { fetchFn, sleep })).resolves.toMatchObject({ assetUrl: 'https://cdn.aitopia.ai/clip.mp4' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(sizes).toEqual([INLINE_UPLOAD_MAX_BYTES + 10, INLINE_UPLOAD_MAX_BYTES + 10, INLINE_UPLOAD_MAX_BYTES + 10]);
    expect(waits).toEqual([1000, 1000]);

    answers = [429, 429, 429, 429, 429];
    sizes.length = 0;
    await expect(uploadSource(call, file, { fetchFn, sleep })).rejects.toThrow(/HTTP 429/);
    expect(sizes).toHaveLength(4);
  });

  it('parses Retry-After and bounds it', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs('999')).toBe(30_000);
    expect(retryAfterMs(null)).toBe(2000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 5_000)).toBe(5000);
  });

  it('refuses a plain-http upload link unless the server is local', async () => {
    const file = join(dir, 'big.mp4');
    writeFileSync(file, Buffer.alloc(INLINE_UPLOAD_MAX_BYTES + 1));
    const call = vi.fn().mockResolvedValue(ok({ status: 'link_created', uploadUrl: 'http://127.0.0.1:9/u/x', maxBytes: 1e9 }));
    const fetchFn = vi.fn();
    await expect(uploadSource(call, file, { fetchFn: fetchFn as unknown as typeof fetch })).rejects.toThrow(/non-https/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
