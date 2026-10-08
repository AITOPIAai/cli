import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { JsonCache, ServerCache, UPLOAD_TTL_MS } from '../src/cache.js';
import { needsRefresh, withTokens, type ServerCredentials } from '../src/credentials.js';
import { handshakeKey, isHandshakeRejection, isToolNotFound, sessionFromClient } from '../src/mcp.js';
import { isAssetGone, UploadCache, uploadSource } from '../src/upload.js';
import type { ToolOutcome } from '../src/envelope.js';

const SERVER = 'https://mcp.aitopia.ai/mcp';
const failed = (payload: Record<string, unknown>): ToolOutcome => ({ payload: { status: 'failed', ...payload }, isError: true, links: [] });
const done = (payload: Record<string, unknown>): ToolOutcome => ({ payload: { status: 'completed', ...payload }, isError: false, links: [] });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aitopia-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ServerCache', () => {
  it('keeps a value per server for its TTL, never across servers, and survives a damaged file', () => {
    let now = 1_000_000;
    const files = new JsonCache(join(dir, 'cache'));
    const cache = new ServerCache<{ a: number }>(files, 'tools', 60_000, () => now);
    expect(cache.get(SERVER)).toBeUndefined();
    cache.set(SERVER, { a: 1 });
    expect(cache.get(SERVER)).toEqual({ a: 1 });
    expect(cache.get('https://staging.aitopia.ai/mcp')).toBeUndefined();
    now += 60_001;
    expect(cache.get(SERVER)).toBeUndefined();
    cache.set(SERVER, { a: 2 });
    const [file] = readdirSync(join(dir, 'cache'));
    writeFileSync(join(dir, 'cache', file!), '{not json');
    expect(cache.get(SERVER)).toBeUndefined();
    cache.clear(SERVER);
    expect(readdirSync(join(dir, 'cache'))).toEqual([]);
  });

  it('an unwritable cache directory never throws', () => {
    writeFileSync(join(dir, 'file'), 'x');
    const cache = new ServerCache<number>(new JsonCache(join(dir, 'file', 'cache')), 'x', 1000);
    expect(() => cache.set(SERVER, 1)).not.toThrow();
    expect(cache.get(SERVER)).toBeUndefined();
  });
});

describe('token expiry', () => {
  const entry = (expiresAt?: string, refresh = true): ServerCredentials => ({
    serverUrl: SERVER,
    savedAt: '',
    tokens: { access_token: 'a', token_type: 'Bearer', ...(refresh ? { refresh_token: 'r' } : {}) },
    ...(expiresAt ? { expiresAt } : {}),
  });

  it('withTokens stores expires_in as an absolute time and drops a stale one', () => {
    const now = Date.parse('2026-10-08T10:00:00Z');
    const next = withTokens(entry('2026-10-08T09:00:00Z'), { access_token: 'b', token_type: 'Bearer', expires_in: 3600 }, now);
    expect(next.expiresAt).toBe('2026-10-08T11:00:00.000Z');
    expect(withTokens(next, { access_token: 'c', token_type: 'Bearer' }, now).expiresAt).toBeUndefined();
  });

  it('needsRefresh: under 60 s left with a refresh token; not without an expiry or a refresh token', () => {
    const now = Date.parse('2026-10-08T10:00:00Z');
    expect(needsRefresh(entry('2026-10-08T10:00:59Z'), now)).toBe(true);
    expect(needsRefresh(entry('2026-10-08T09:00:00Z'), now)).toBe(true);
    expect(needsRefresh(entry('2026-10-08T10:01:01Z'), now)).toBe(false);
    expect(needsRefresh(entry(undefined), now)).toBe(false);
    expect(needsRefresh(entry('2026-10-08T09:00:00Z', false), now)).toBe(false);
    // Saved by 0.4.1: savedAt + expires_in.
    const legacy = (savedAt: string): ServerCredentials => ({ ...entry(undefined), savedAt, tokens: { ...entry().tokens!, expires_in: 3600 } });
    expect(needsRefresh(legacy('2026-10-08T08:30:00Z'), now)).toBe(true);
    expect(needsRefresh(legacy('2026-10-08T09:30:00Z'), now)).toBe(false);
  });
});

describe('handshake and tool-list helpers', () => {
  it('handshakeKey changes with the server version or instructions', () => {
    const base = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's', version: '1.0.0' } };
    expect(handshakeKey(base)).toBe(handshakeKey({ ...base }));
    expect(handshakeKey(base)).not.toBe(handshakeKey({ ...base, serverInfo: { name: 's', version: '1.0.1' } }));
    expect(handshakeKey(base)).not.toBe(handshakeKey({ ...base, instructionsHash: 'x' }));
  });

  it('isHandshakeRejection only for a 400 or a not-initialized error', () => {
    expect(isHandshakeRejection(new StreamableHTTPError(400, 'Bad Request: Server not initialized'))).toBe(true);
    expect(isHandshakeRejection(new StreamableHTTPError(500, 'boom'))).toBe(false);
    expect(isHandshakeRejection(new TypeError('fetch failed'))).toBe(false);
  });

  it('isToolNotFound: TOOL_NOT_FOUND or an unknown-tool text', () => {
    expect(isToolNotFound(failed({ code: 'TOOL_NOT_FOUND', error: 'There is no x tool on this connection.' }))).toBe(true);
    expect(isToolNotFound(failed({ code: 'NOT_FOUND', error: 'Unknown tool x' }))).toBe(true);
    expect(isToolNotFound(failed({ code: 'MODEL_NOT_FOUND', error: 'There is no model x' }))).toBe(false);
    expect(isToolNotFound(done({}))).toBe(false);
  });
});

describe('upload cache', () => {
  it('isAssetGone: ASSET_UNREACHABLE, 404 and expired texts; not other failures', () => {
    expect(isAssetGone(failed({ code: 'ASSET_UNREACHABLE', error: 'x' }))).toBe(true);
    expect(isAssetGone(failed({ code: 'INVALID_INPUT', error: 'Could not fetch imageUrl: HTTP 404' }))).toBe(true);
    expect(isAssetGone(failed({ error: 'The asset URL has expired.' }))).toBe(true);
    expect(isAssetGone(failed({ code: 'INSUFFICIENT_CREDITS', error: 'Not enough credits' }))).toBe(false);
    expect(isAssetGone(done({}))).toBe(false);
  });

  it('reuses a URL for the same bytes and project, uploads again for another project or after 7 days', async () => {
    let now = 5_000_000;
    const cache = new UploadCache(new JsonCache(join(dir, 'cache')), SERVER, () => now);
    const file = join(dir, 'a.png');
    writeFileSync(file, 'png bytes');
    let n = 0;
    const call = vi.fn(async () => done({ assetUrl: `https://cdn.aitopia.ai/${++n}.png`, assetId: `id-${n}` }));
    const first = await uploadSource(call, file, { cache });
    const second = await uploadSource(call, file, { cache });
    expect(second).toMatchObject({ assetUrl: first.assetUrl, cached: true });
    expect(second.outcome.payload.assetId).toBe('id-1');
    expect(call).toHaveBeenCalledTimes(1);
    expect((await uploadSource(call, file, { cache, scope: { projectId: 'p-1' } })).assetUrl).toBe('https://cdn.aitopia.ai/2.png');
    // refresh (aitopia upload): always sent, and the new URL is cached.
    expect((await uploadSource(call, file, { cache, refresh: true })).assetUrl).toBe('https://cdn.aitopia.ai/3.png');
    expect((await uploadSource(call, file, { cache })).assetUrl).toBe('https://cdn.aitopia.ai/3.png');
    now += UPLOAD_TTL_MS + 1;
    expect((await uploadSource(call, file, { cache })).cached).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('remote URLs and caches of other servers are not shared', async () => {
    const files = new JsonCache(join(dir, 'cache'));
    const file = join(dir, 'a.png');
    writeFileSync(file, 'png bytes');
    const call = vi.fn(async () => done({ assetUrl: 'https://cdn.aitopia.ai/x.png' }));
    await uploadSource(call, file, { cache: new UploadCache(files, SERVER) });
    await uploadSource(call, file, { cache: new UploadCache(files, 'https://staging.aitopia.ai/mcp') });
    expect(call).toHaveBeenCalledTimes(2);
    new UploadCache(files, SERVER).clearServer();
    await uploadSource(call, file, { cache: new UploadCache(files, SERVER) });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('a session re-uploads a cached file once when the tool cannot read its URL, then retries the call', async () => {
    const files = new JsonCache(join(dir, 'cache'));
    const file = join(dir, 'a.png');
    writeFileSync(file, 'png bytes');
    const seed = new UploadCache(files, SERVER);
    await uploadSource(async () => done({ assetUrl: 'https://cdn.aitopia.ai/old.png' }), file, { cache: seed });

    const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
    const client = {
      callTool: vi.fn(async (req: { name: string; arguments: Record<string, unknown> }) => {
        toolCalls.push(req);
        if (req.name === 'upload_asset') return text({ status: 'completed', assetUrl: 'https://cdn.aitopia.ai/new.png' });
        const url = (req.arguments.images as string[])[0];
        // Always gone: the retry happens once, then the failure is returned.
        if (url) return { ...text({ status: 'failed', code: 'ASSET_UNREACHABLE', error: 'HTTP 404' }), isError: true };
        return text({ status: 'completed' });
      }),
    } as unknown as Client;
    const uploads = new UploadCache(files, SERVER);
    const session = sessionFromClient(client, SERVER, { uploads });
    const { assetUrl } = await uploadSource(session.callTool, file, { cache: uploads });
    expect(assetUrl).toBe('https://cdn.aitopia.ai/old.png');
    const outcome = await session.callTool('edit', { images: [assetUrl], note: 'keep' });
    expect(outcome.payload.code).toBe('ASSET_UNREACHABLE');
    expect(toolCalls.map((c) => [c.name, c.arguments.images])).toEqual([
      ['edit', ['https://cdn.aitopia.ai/old.png']],
      ['upload_asset', undefined],
      ['edit', ['https://cdn.aitopia.ai/new.png']],
    ]);
    expect(toolCalls[2]?.arguments.note).toBe('keep');
    expect(uploads.get(uploads.key(await import('../src/upload.js').then((m) => m.fileSha256(file)), 9))?.assetUrl).toBe(
      'https://cdn.aitopia.ai/new.png',
    );
  });
});
