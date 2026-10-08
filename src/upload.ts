import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { CliError, EXIT, UsageError, failureToError } from './errors.js';
import { buyCreditsUrl, isFailed, type ToolOutcome } from './envelope.js';
import { assertTransferUrl } from './download.js';
import type { ToolCaller } from './mcp.js';
import { UPLOAD_TTL_MS, type JsonCache } from './cache.js';

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
  /** The file was uploaded before (same bytes, same project): its hosted URL came from the local cache. */
  cached?: boolean;
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
  /** Save the file in this project (and folder): projectId / folderId on upload_asset and create_upload_link. */
  scope?: { projectId?: string; folderId?: string };
  /** Reuse the hosted URL of a file uploaded before (same sha256, size, server and project). */
  cache?: UploadCache;
  /** Upload even when the cache has the file (the new URL replaces the cached one). */
  refresh?: boolean;
}

/** sha256 of a file, read as a stream. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

interface UploadEntry {
  assetUrl: string;
  fileName?: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

interface UploadsFile {
  version: 1;
  entries: Record<string, UploadEntry>;
}

/** Most entries kept in uploads.json (the newest win). */
export const MAX_UPLOAD_ENTRIES = 500;

const UPLOADS_FILE = 'uploads.json';

/** Failure codes / texts meaning the server could not fetch a file URL we sent. */
export function isAssetGone(outcome: ToolOutcome): boolean {
  if (!isFailed(outcome)) return false;
  const { code, error } = outcome.payload;
  if (typeof code === 'string' && /^(ASSET_UNREACHABLE|ASSET_NOT_FOUND|ASSET_EXPIRED|FILE_NOT_FOUND|SOURCE_NOT_FOUND)$/.test(code)) return true;
  return typeof error === 'string' && /\b(404|410)\b|could not be downloaded|(file|asset|url)\b.{0,40}\b(not found|expired|gone)/i.test(error);
}

/**
 * Local file → hosted URL, per server, for 7 days (uploads.json in the cache
 * directory). Keyed by sha256 + size + project/folder, so a changed file or
 * another project uploads again. A URL served from here that a tool later
 * cannot read (404, expired) is uploaded again once (see replaceGone).
 */
export class UploadCache {
  /** Hosted URLs this process took from the cache → how to upload them again. */
  private readonly served = new Map<string, { key: string; path: string; options: UploadOptions }>();

  constructor(
    private readonly files: JsonCache,
    readonly serverUrl: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = UPLOAD_TTL_MS,
  ) {}

  key(sha256: string, size: number, scope: UploadOptions['scope'] = {}): string {
    return [this.serverUrl, sha256, size, scope.projectId ?? '', scope.folderId ?? ''].join('|');
  }

  private read(): UploadsFile {
    const file = this.files.read<UploadsFile>(UPLOADS_FILE);
    return file && typeof file.entries === 'object' && file.entries ? { version: 1, entries: file.entries } : { version: 1, entries: {} };
  }

  private fresh(entry: UploadEntry | undefined): entry is UploadEntry {
    if (!entry || typeof entry.assetUrl !== 'string' || typeof entry.createdAt !== 'number') return false;
    const age = this.now() - entry.createdAt;
    return age >= 0 && age <= this.ttlMs;
  }

  get(key: string): UploadEntry | undefined {
    const entry = this.read().entries[key];
    return this.fresh(entry) ? entry : undefined;
  }

  private save(change: (entries: Record<string, UploadEntry>) => void): void {
    const file = this.read();
    change(file.entries);
    const kept = Object.entries(file.entries)
      .filter(([, e]) => this.fresh(e))
      .sort((a, b) => b[1].createdAt - a[1].createdAt)
      .slice(0, MAX_UPLOAD_ENTRIES);
    this.files.write(UPLOADS_FILE, { version: 1, entries: Object.fromEntries(kept) } satisfies UploadsFile);
  }

  set(key: string, entry: Omit<UploadEntry, 'createdAt'>): void {
    this.save((entries) => {
      entries[key] = { ...entry, createdAt: this.now() };
    });
  }

  forget(key: string): void {
    this.save((entries) => {
      delete entries[key];
    });
  }

  /** Drops every entry of this server (after login / logout). */
  clearServer(): void {
    this.served.clear();
    this.save((entries) => {
      for (const key of Object.keys(entries)) if (key.startsWith(`${this.serverUrl}|`)) delete entries[key];
    });
  }

  noteServed(assetUrl: string, key: string, path: string, options: UploadOptions): void {
    this.served.set(assetUrl, { key, path, options });
  }

  /**
   * After a failed tool call: when it failed because a file URL could not be
   * read and the arguments hold URLs served from this cache, those files are
   * uploaded again (each once per process) and the arguments returned with
   * the new URLs. Undefined when there is nothing to retry.
   */
  async replaceGone(outcome: ToolOutcome, args: Record<string, unknown>, call: ToolCaller): Promise<Record<string, unknown> | undefined> {
    if (!isAssetGone(outcome) || this.served.size === 0) return undefined;
    const text = JSON.stringify(args);
    const swaps = new Map<string, string>();
    for (const [url, origin] of [...this.served]) {
      if (!text.includes(JSON.stringify(url).slice(1, -1))) continue;
      this.served.delete(url);
      this.forget(origin.key);
      const again = await uploadSource(call, origin.path, { ...origin.options, cache: this, refresh: true });
      swaps.set(url, again.assetUrl);
    }
    if (swaps.size === 0) return undefined;
    return replaceStrings(args, swaps) as Record<string, unknown>;
  }
}

/** Copies a JSON value with every string found in `swaps` replaced. */
function replaceStrings(value: unknown, swaps: Map<string, string>): unknown {
  if (typeof value === 'string') return swaps.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceStrings(v, swaps));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceStrings(v, swaps)]));
  }
  return value;
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
  const scope = options.scope ?? {};
  if (isRemoteUrl(source)) {
    const outcome = await wait(await call('create_upload_link', { sourceUrl: source, ...scope }));
    return { source, assetUrl: completedAssetUrl(outcome, source), outcome };
  }

  const { path, size } = assertLocalFile(source);
  const fileName = basename(path);
  const contentType = contentTypeFor(fileName);

  const cache = options.cache;
  const cacheKey = cache ? cache.key(await fileSha256(path), size, scope) : undefined;
  if (cache && cacheKey && !options.refresh) {
    const hit = cache.get(cacheKey);
    if (hit) {
      cache.noteServed(hit.assetUrl, cacheKey, path, options);
      const outcome: ToolOutcome = { payload: { status: 'completed', ...hit.payload, assetUrl: hit.assetUrl }, isError: false, links: [] };
      return { source, fileName, assetUrl: hit.assetUrl, outcome, cached: true };
    }
  }
  const remember = (result: UploadResult): UploadResult => {
    if (cache && cacheKey) cache.set(cacheKey, { assetUrl: result.assetUrl, fileName, payload: smallPayload(result.outcome.payload) });
    return result;
  };

  if (size <= INLINE_UPLOAD_MAX_BYTES) {
    const contentBase64 = readFileSync(path).toString('base64');
    const outcome = await call('upload_asset', { fileName, contentBase64, ...scope });
    return remember({ source, fileName, assetUrl: completedAssetUrl(outcome, source), outcome });
  }

  const link = await call('create_upload_link', { fileName, ...(contentType ? { contentType } : {}), ...scope });
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
  return remember({ source, fileName, assetUrl: completedAssetUrl(outcome, source), outcome });
}

/** The scalar fields of an upload answer (ids, URL, size), at most 2 KB, for the cache. */
function smallPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return JSON.stringify(out).length <= 2048 ? out : {};
}
