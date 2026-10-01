import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { CliError, EXIT, UsageError, failureToError } from './errors.js';
import { buyCreditsUrl, isFailed, type ToolOutcome } from './envelope.js';
import { assertTransferUrl } from './download.js';
import type { ToolCaller } from './mcp.js';

/** Files up to this size go inline (base64) through upload_asset. */
export const INLINE_UPLOAD_MAX_BYTES = 100 * 1024;
/** Upload-link cap when the server does not state maxBytes. */
export const DEFAULT_LINK_MAX_BYTES = 95 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.json': 'application/json',
};

export function contentTypeFor(fileName: string): string | undefined {
  return CONTENT_TYPES[extname(fileName).toLowerCase()];
}

export function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface UploadResult {
  source: string;
  assetUrl: string;
  fileName?: string;
  outcome: ToolOutcome;
}

function completedAssetUrl(outcome: ToolOutcome, source: string): string {
  if (isFailed(outcome)) throw failureToError(outcome.payload, { buyCreditsUrl: buyCreditsUrl(outcome) });
  const url = outcome.payload.assetUrl;
  if (typeof url !== 'string' || !url) {
    throw new CliError(`The server did not return a file URL for ${source}.`, EXIT.FAILED, { data: outcome.payload });
  }
  return url;
}

export type WaitFn = (outcome: ToolOutcome) => Promise<ToolOutcome>;

/** Retries of a PUT answered 429 (same single-use link; it is not used up by a 429). */
export const MAX_UPLOAD_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 30_000;

/** Retry-After in ms (seconds or an HTTP date), bounded; 2 s when absent. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now));
  }
  return 2000;
}

/** Checks that a local file exists, is a regular file and is not empty (exit 2 otherwise). */
export function assertLocalFile(source: string): { path: string; size: number } {
  const path = resolve(source);
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new UsageError(`Not a file: ${source}`);
    size = stat.size;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new UsageError(`Cannot read ${source}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  if (size === 0) throw new UsageError(`File is empty: ${source}`);
  return { path, size };
}

export interface UploadOptions {
  fetchFn?: typeof fetch;
  wait?: WaitFn;
  allowHttpLoopback?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Uploads a local file (or imports a public URL) and returns its hosted URL.
 * Small files (<= 100 KB) go base64 through upload_asset; larger ones get a
 * single-use link from create_upload_link and are streamed with a PUT.
 */
export async function uploadSource(
  call: ToolCaller,
  source: string,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const wait = options.wait ?? (async (o: ToolOutcome) => o);
  if (isRemoteUrl(source)) {
    const outcome = await wait(await call('create_upload_link', { sourceUrl: source }));
    return { source, assetUrl: completedAssetUrl(outcome, source), outcome };
  }

  const { path, size } = assertLocalFile(source);
  const fileName = basename(path);
  const contentType = contentTypeFor(fileName);

  if (size <= INLINE_UPLOAD_MAX_BYTES) {
    const contentBase64 = readFileSync(path).toString('base64');
    const outcome = await call('upload_asset', { fileName, contentBase64 });
    return { source, fileName, assetUrl: completedAssetUrl(outcome, source), outcome };
  }

  const link = await call('create_upload_link', { fileName, ...(contentType ? { contentType } : {}) });
  if (isFailed(link)) throw failureToError(link.payload, { buyCreditsUrl: buyCreditsUrl(link) });
  const uploadUrl = link.payload.uploadUrl;
  if (typeof uploadUrl !== 'string') throw new CliError('The server did not return an upload link.');
  const maxBytes =
    typeof link.payload.maxBytes === 'number' && link.payload.maxBytes > 0 ? link.payload.maxBytes : DEFAULT_LINK_MAX_BYTES;
  if (size > maxBytes) {
    throw new UsageError(`${fileName} is ${formatBytes(size)}; the upload limit is ${formatBytes(maxBytes)}.`);
  }
  assertTransferUrl(uploadUrl, options.allowHttpLoopback === true, 'upload to');

  const doFetch = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers: Record<string, string> = {
    'Content-Length': String(size),
    'X-File-Name': encodeURIComponent(fileName),
  };
  if (contentType) headers['Content-Type'] = contentType;
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await doFetch(uploadUrl, {
      method: 'PUT',
      headers,
      // A fresh stream per attempt: a body stream can be read only once.
      body: Readable.toWeb(createReadStream(path)) as unknown as RequestInit['body'],
      duplex: 'half',
      redirect: 'error',
    } as RequestInit & { duplex: 'half' });
    if (res.status !== 429 || attempt >= MAX_UPLOAD_RETRIES) break;
    await res.body?.cancel().catch(() => undefined);
    await sleep(retryAfterMs(res.headers.get('retry-after')));
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const message = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new CliError(`Upload of ${fileName} failed: ${message}`, EXIT.FAILED, { code: 'UPLOAD_FAILED' });
  }
  const outcome: ToolOutcome = { payload: { status: 'completed', ...body }, isError: false, links: [] };
  return { source, fileName, assetUrl: completedAssetUrl(outcome, source), outcome };
}
