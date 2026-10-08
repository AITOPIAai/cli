import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, type Env } from './config.js';

const IS_WINDOWS = process.platform === 'win32';

/** Local cache directory: <config dir>/cache. */
export function cacheDir(env: Env = process.env): string {
  return join(configDir(env), 'cache');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Short stable file-name key for a server URL. */
export function serverKey(serverUrl: string): string {
  return sha256Hex(serverUrl).slice(0, 16);
}

/**
 * Best-effort JSON files in the cache directory. A missing, damaged or
 * unwritable cache never fails a command: reads return undefined, writes are
 * dropped. Writes go to a temporary file renamed over the old one, so parallel
 * commands never see half a file (the last writer wins).
 */
export class JsonCache {
  constructor(readonly dir: string) {}

  read<T>(name: string): T | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  write(name: string, value: unknown): void {
    const tmp = join(this.dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      if (!IS_WINDOWS) chmodSync(tmp, 0o600);
      renameSync(tmp, join(this.dir, name));
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // nothing was written
      }
    }
  }

  remove(name: string): void {
    try {
      rmSync(join(this.dir, name), { force: true });
    } catch {
      // best effort
    }
  }
}

/** A cached value with the time it was stored. */
export interface Stamped<T> {
  serverUrl: string;
  savedAt: number;
  value: T;
}

/** One value per server URL, valid for `ttlMs`. */
export class ServerCache<T> {
  constructor(
    private readonly cache: JsonCache,
    private readonly prefix: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private file(serverUrl: string): string {
    return `${this.prefix}-${serverKey(serverUrl)}.json`;
  }

  get(serverUrl: string): T | undefined {
    const entry = this.cache.read<Stamped<T>>(this.file(serverUrl));
    if (!entry || entry.serverUrl !== serverUrl || typeof entry.savedAt !== 'number') return undefined;
    const age = this.now() - entry.savedAt;
    if (age < 0 || age > this.ttlMs) return undefined;
    return entry.value;
  }

  set(serverUrl: string, value: T): void {
    this.cache.write(this.file(serverUrl), { serverUrl, savedAt: this.now(), value } satisfies Stamped<T>);
  }

  clear(serverUrl: string): void {
    this.cache.remove(this.file(serverUrl));
  }
}

/** OAuth discovery metadata is stable; a failed refresh drops it early. */
export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
/** initialize result (protocol version, capabilities, server version, instructions hash). */
export const HANDSHAKE_TTL_MS = 60 * 60 * 1000;
/** tools/list result. */
export const TOOLS_TTL_MS = 60 * 60 * 1000;
/** Uploaded file → hosted URL. */
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
