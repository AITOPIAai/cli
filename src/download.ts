import { createWriteStream, type WriteStream, existsSync, linkSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { CliError, EXIT } from './errors.js';
import { isLoopbackHost } from './config.js';

/** Extensions a downloaded file may get; anything else is saved as .bin. */
export const ALLOWED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif',
  'mp4', 'mov', 'webm',
  'm4a', 'mp3', 'wav', 'ogg', 'flac', 'aac',
  'json', 'txt', 'srt', 'vtt', 'zip',
]);

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'application/json': 'json',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/vtt': 'vtt',
  'application/x-subrip': 'srt',
};

/** Max redirects followed for one download; each hop is checked again. */
export const MAX_REDIRECTS = 5;
/** A download that receives no bytes for this long is stopped. */
export const IDLE_TIMEOUT_MS = 60_000;
/** Largest file the CLI downloads. */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_NAME_LENGTH = 120;

/**
 * Makes a server-provided name safe as a single file name: no directories,
 * no control or reserved characters, no leading dots, bounded length.
 */
export function sanitizeFileName(raw: string, fallback = 'aitopia'): string {
  let name = raw.normalize('NFC');
  // Keep only the last path segment, for both separators.
  name = name.split(/[/\\]/).pop() ?? '';
  // Characters are filtered one by one: controls and those not allowed on Windows.
  name = Array.from(name)
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f || '<>:"|?*'.includes(ch) ? '_' : ch))
    .join('');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length > MAX_NAME_LENGTH) {
    const ext = extname(name);
    const keep = ext.length > 0 && ext.length <= 10 ? ext : '';
    name = name.slice(0, MAX_NAME_LENGTH - keep.length) + keep;
  }
  return name || fallback;
}

/** File extension (without dot) from a Content-Type, else from the URL path; only allowed media types, else "bin". */
export function extensionFor(contentType: string | null | undefined, url?: string): string {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  const fromType = type ? CONTENT_TYPE_EXTENSIONS[type] : undefined;
  if (fromType) return fromType;
  if (url) {
    try {
      const ext = extname(decodeURIComponent(new URL(url).pathname)).slice(1).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) return ext;
    } catch {
      // ignore
    }
  }
  return 'bin';
}

const SLUG_MAX_LENGTH = 48;

/**
 * A clean file name stem: lowercase ASCII words joined by "-", at most 48
 * characters, cut at a word boundary. Empty when nothing usable is left.
 */
export function slugify(text: string | undefined, maxLength = SLUG_MAX_LENGTH): string {
  if (!text) return '';
  const words = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > maxLength) {
      if (!slug) slug = word.slice(0, maxLength);
      break;
    }
    slug = next;
  }
  return slug;
}

function stripExtension(name: string): string {
  const ext = extname(name);
  return ext && ext.length <= 6 ? name.slice(0, -ext.length) : name;
}

/** Base name (no extension) for an asset: a slug of its asset name, else of the prompt, else "aitopia". */
export function baseNameFor(assetName?: string, fallback?: string): string {
  // The server shortens long prompts into names ending with "…"; the full prompt reads better.
  const shortened = assetName !== undefined && /(?:…|\.\.\.)$/.test(stripExtension(assetName).trim());
  const fromAsset = shortened && slugify(fallback) ? '' : slugify(assetName ? stripExtension(assetName) : undefined);
  const name = fromAsset || slugify(fallback) || 'aitopia';
  return sanitizeFileName(name);
}

/** `path` itself if free (or if force), else `name-1.ext`, `name-2.ext`, ... */
export function uniquePath(path: string, force: boolean, exists: (p: string) => boolean = existsSync): string {
  if (force || !exists(path)) return path;
  const ext = extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  throw new CliError(`Could not find a free file name next to ${path}.`);
}

export interface OutputTarget {
  kind: 'dir' | 'file';
  path: string;
}

/** -o: a directory (existing, or ending with a separator) or a file path. Default: the current directory. */
export function resolveOutputTarget(output: string | undefined, cwd = process.cwd()): OutputTarget {
  if (!output) return { kind: 'dir', path: cwd };
  const path = resolve(cwd, output);
  if (output.endsWith('/') || output.endsWith(sep) || output === '.' || output === '..') return { kind: 'dir', path };
  try {
    if (statSync(path).isDirectory()) return { kind: 'dir', path };
  } catch {
    // does not exist: a file path
  }
  return { kind: 'file', path };
}

/** Where asset number `index` of `total` goes, before the collision check. */
export function targetPath(
  target: OutputTarget,
  info: {
    url: string;
    assetName?: string;
    fallbackName?: string;
    contentType?: string | null;
    index: number;
    total: number;
    /** File `sub` of `subTotal` of the same item (an item with several files: base-N-k). */
    sub?: number;
    subTotal?: number;
  },
): string {
  const ext = extensionFor(info.contentType, info.url);
  const parts: number[] = [];
  if (info.total > 1) parts.push(info.index + 1);
  if ((info.subTotal ?? 1) > 1) parts.push((info.sub ?? 0) + 1);
  const suffix = parts.map((n) => `-${n}`).join('');
  if (target.kind === 'dir') {
    // Batch items are named "<name> 1", "<name> 2" by the server: number them once.
    const assetName = info.total > 1 ? info.assetName?.replace(/\s+\d+$/, '') : info.assetName;
    const base = baseNameFor(assetName, info.fallbackName);
    return join(target.path, `${base}${suffix}.${ext}`);
  }
  const given = target.path;
  const givenExt = extname(given);
  const stem = givenExt ? given.slice(0, -givenExt.length) : given;
  const finalExt = givenExt || `.${ext}`;
  return `${stem}${suffix}${finalExt}`;
}

const activeTempFiles = new Set<string>();

/** Resolves once the file handle is released (destroying the stream if it is still open). */
function closeStream(stream: WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((done) => {
    stream.once('close', () => done());
    stream.destroy();
  });
}

/** Removes partial downloads (called on exit and Ctrl+C). */
export function cleanupTempFiles(): void {
  for (const file of activeTempFiles) rmSync(file, { force: true });
  activeTempFiles.clear();
}

/** https only; http only to a loopback host, and only when the CLI itself talks to a loopback server. */
export function assertTransferUrl(url: string, allowHttpLoopback: boolean, what = 'download from'): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`The server returned an invalid URL: ${url}`);
  }
  const ok = parsed.protocol === 'https:' || (allowHttpLoopback && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname));
  if (!ok) throw new CliError(`Refusing to ${what} a non-https URL: ${url}`);
  return parsed;
}

/** Moves tmp to dest without replacing an existing file (unless force); returns the final path. */
function place(tmp: string, dest: string, force: boolean): string {
  if (force) {
    renameSync(tmp, dest);
    return dest;
  }
  let candidate = uniquePath(dest, false);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      // link() fails if the name is taken, so an existing file is never replaced.
      linkSync(tmp, candidate);
      rmSync(tmp, { force: true });
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        candidate = uniquePath(dest, false);
        continue;
      }
      // File systems without hard links: check, then rename.
      if (!existsSync(candidate)) {
        renameSync(tmp, candidate);
        return candidate;
      }
      candidate = uniquePath(dest, false);
    }
  }
  throw new CliError(`Could not save the file next to ${dest}.`);
}

export interface DownloadOptions {
  target: OutputTarget;
  index: number;
  total: number;
  /** Position among one item's own files (see targetPath). */
  sub?: number;
  subTotal?: number;
  assetName?: string;
  /** Used for the file name when there is no asset name (the prompt). */
  fallbackName?: string;
  force: boolean;
  /** Allow http to 127.0.0.1/localhost (only when the server URL is loopback). */
  allowHttpLoopback?: boolean;
  fetchFn?: typeof fetch;
  idleTimeoutMs?: number;
  maxBytes?: number;
}

/** GET with manual redirects: at most MAX_REDIRECTS hops, each URL checked again. */
async function fetchChecked(url: string, options: DownloadOptions, signal: AbortSignal): Promise<{ res: Response; finalUrl: string }> {
  const doFetch = options.fetchFn ?? fetch;
  let current = url;
  for (let hop = 0; ; hop++) {
    assertTransferUrl(current, options.allowHttpLoopback === true);
    const res = await doFetch(current, { redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      await res.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new CliError(`Too many redirects while downloading ${url}.`, EXIT.FAILED, { code: 'DOWNLOAD_FAILED' });
      current = new URL(res.headers.get('location') as string, current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
}

/** Streams one asset to disk (temp file, then rename). Returns the saved path. */
export async function downloadAsset(url: string, options: DownloadOptions): Promise<string> {
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new CliError(`Download stalled (no data for ${Math.round(idleMs / 1000)} s): ${url}`, EXIT.FAILED, { code: 'DOWNLOAD_FAILED' })), idleMs);
  };
  touch();
  let tmp: string | undefined;
  let sink: WriteStream | undefined;
  try {
    const { res, finalUrl } = await fetchChecked(url, options, controller.signal);
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new CliError(`Download failed (HTTP ${res.status}): ${url}`, EXIT.FAILED, { code: 'DOWNLOAD_FAILED' });
    }
    const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    const cap = Math.min(options.maxBytes ?? MAX_DOWNLOAD_BYTES, Number.isFinite(declared) && declared >= 0 ? declared : Infinity);
    if (Number.isFinite(declared) && declared > (options.maxBytes ?? MAX_DOWNLOAD_BYTES)) {
      await res.body.cancel().catch(() => undefined);
      throw new CliError(`The file is too large to download (${declared} bytes): ${url}`, EXIT.FAILED, { code: 'DOWNLOAD_FAILED' });
    }
    const dest = targetPath(options.target, {
      url: finalUrl,
      assetName: options.assetName,
      fallbackName: options.fallbackName,
      contentType: res.headers.get('content-type'),
      index: options.index,
      total: options.total,
      sub: options.sub,
      subTotal: options.subTotal,
    });
    const dir = dirname(dest);
    mkdirSync(dir, { recursive: true });
    tmp = join(dir, `.${basename(dest)}.${randomBytes(4).toString('hex')}.part`);
    activeTempFiles.add(tmp);
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        touch();
        received += chunk.length;
        if (received > cap) {
          done(new CliError(`The download is larger than expected; stopped at ${cap} bytes: ${url}`, EXIT.FAILED, { code: 'DOWNLOAD_FAILED' }));
          return;
        }
        done(null, chunk);
      },
    });
    sink = createWriteStream(tmp, { flags: 'wx' });
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), meter, sink, {
      signal: controller.signal,
    });
    await closeStream(sink);
    return place(tmp, dest, options.force);
  } catch (error) {
    const reason = controller.signal.reason as unknown;
    if (controller.signal.aborted && reason instanceof CliError) throw reason;
    throw error;
  } finally {
    clearTimeout(idle);
    // Windows cannot delete a file that is still open: wait for the stream to close first.
    if (sink) await closeStream(sink);
    if (tmp) {
      rmSync(tmp, { force: true });
      activeTempFiles.delete(tmp);
    }
  }
}
