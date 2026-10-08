import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { CliError } from './errors.js';

/** What is kept for one server. */
export interface ServerCredentials {
  serverUrl: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When the access token expires (ISO time, from expires_in when the tokens were saved). */
  expiresAt?: string;
  savedAt: string;
}

/** Entry fields for newly received tokens: the tokens and their expiry (dropped when the server gave none). */
export function withTokens(entry: ServerCredentials, tokens: OAuthTokens, now = Date.now()): ServerCredentials {
  const next: ServerCredentials = { ...entry, tokens };
  const seconds = Number(tokens.expires_in);
  if (Number.isFinite(seconds) && seconds > 0) next.expiresAt = new Date(now + seconds * 1000).toISOString();
  else delete next.expiresAt;
  return next;
}

/** Refresh this long before the stored expiry, so a request never goes out with a dying token. */
export const REFRESH_MARGIN_MS = 60_000;

/** Whether the stored access token is (nearly) expired and a refresh token can renew it. */
export function needsRefresh(entry: ServerCredentials | undefined, now = Date.now(), marginMs = REFRESH_MARGIN_MS): boolean {
  if (!entry?.tokens?.refresh_token) return false;
  // Saved before 0.4.2 (no expiresAt): savedAt + expires_in; a wrong guess only refreshes early.
  const seconds = Number(entry.tokens.expires_in);
  const expires = entry.expiresAt
    ? Date.parse(entry.expiresAt)
    : Number.isFinite(seconds) && seconds > 0
      ? Date.parse(entry.savedAt) + seconds * 1000
      : NaN;
  return Number.isFinite(expires) && expires - now < marginMs;
}

interface CredentialsFile {
  version: 1;
  servers: Record<string, ServerCredentials>;
}

const IS_WINDOWS = process.platform === 'win32';
/** A lock file older than this is left over from a crashed process. */
export const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The real path (on Windows this expands 8.3 short names like RUNNER~1); the input when it cannot be resolved. */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Whether child is parent or below it. On Windows both are compared as real
 * paths and without regard to case, so C:\Users\RUNNER~1\x is inside
 * C:\Users\runneradmin.
 */
export function isInside(child: string, parent: string, windows = IS_WINDOWS): boolean {
  const path = windows ? win32 : posix;
  const norm = (p: string) => {
    const full = path.resolve(realPath(p));
    return windows ? full.toLowerCase() : full;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface CredentialStoreOptions {
  warn?: (message: string) => void;
}

/**
 * credentials.json in the config directory. The directory is 0700 and the file
 * 0600 (skipped on Windows, where the user profile ACL protects it). Every
 * read-modify-write holds credentials.lock, so parallel commands do not undo
 * each other's token refresh. Writes go to a temporary file that is renamed
 * over the old one. Entries are keyed by server URL, so staging and production
 * sign-ins never mix. A config directory that is a symlink or owned by another
 * user is refused.
 */
export class CredentialStore {
  readonly path: string;
  private readonly dir: string;
  private readonly warn?: (message: string) => void;
  private dirChecked = false;

  constructor(path: string, options: CredentialStoreOptions = {}) {
    this.path = path;
    this.dir = dirname(path);
    this.warn = options.warn;
  }

  get(serverUrl: string): ServerCredentials | undefined {
    return this.read().servers[serverUrl];
  }

  /** Applies `change` to the entry for serverUrl (created if missing) and saves the file, under the lock. */
  update(serverUrl: string, change: (entry: ServerCredentials) => ServerCredentials | undefined): void {
    this.withLock(() => {
      const file = this.read();
      const current = file.servers[serverUrl] ?? { serverUrl, savedAt: new Date().toISOString() };
      const next = change({ ...current });
      if (next === undefined) delete file.servers[serverUrl];
      else file.servers[serverUrl] = { ...next, serverUrl, savedAt: new Date().toISOString() };
      this.write(file);
    });
  }

  remove(serverUrl: string): boolean {
    let removed = false;
    this.withLock(() => {
      const file = this.read();
      if (!file.servers[serverUrl]) return;
      delete file.servers[serverUrl];
      this.write(file);
      removed = true;
    });
    return removed;
  }

  /** Checks the config directory; creates it (0700) when missing. */
  private ensureDir(create: boolean): boolean {
    const stat = lstatOrUndefined(this.dir);
    if (!stat) {
      if (!create) return false;
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // Only a directory the CLI created is chmod'ed; an existing one is the user's choice.
      if (!IS_WINDOWS) chmodSync(this.dir, 0o700);
      this.dirChecked = true;
      return true;
    }
    if (this.dirChecked) return true;
    if (stat.isSymbolicLink()) {
      throw new CliError(`Refusing to use ${this.dir}: it is a symbolic link.`, 1, {
        code: 'CONFIG_DIR_UNSAFE',
        hint: 'Point AITOPIA_CONFIG_DIR at a real directory you own.',
      });
    }
    if (!stat.isDirectory()) throw new CliError(`${this.dir} is not a directory.`, 1, { code: 'CONFIG_DIR_UNSAFE' });
    if (!IS_WINDOWS && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new CliError(`Refusing to use ${this.dir}: it belongs to another user.`, 1, {
        code: 'CONFIG_DIR_UNSAFE',
        hint: 'Point AITOPIA_CONFIG_DIR at a directory you own.',
      });
    }
    if (IS_WINDOWS && !isInside(this.dir, process.env.USERPROFILE || homedir())) {
      this.warn?.(`${this.dir} is outside your user profile; other users may be able to read your sign-in.`);
    }
    this.dirChecked = true;
    return true;
  }

  private withLock(fn: () => void): void {
    this.ensureDir(true);
    const lock = join(this.dir, 'credentials.lock');
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lock, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let age: number;
        try {
          age = Date.now() - statSync(lock).mtimeMs;
        } catch {
          continue; // removed meanwhile: try again
        }
        if (age > STALE_LOCK_MS) {
          rmSync(lock, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new CliError('Another aitopia command is updating the sign-in. Try again in a moment.', 1, {
            code: 'CREDENTIALS_LOCKED',
            hint: `If no other aitopia command is running, delete ${lock}.`,
          });
        }
        sleepSync(25 + Math.floor(Math.random() * 50));
      }
    }
    try {
      fn();
    } finally {
      closeSync(fd);
      rmSync(lock, { force: true });
    }
  }

  private read(): CredentialsFile {
    if (!this.ensureDir(false)) return { version: 1, servers: {} };
    const stat = lstatOrUndefined(this.path);
    if (!stat) return { version: 1, servers: {} };
    if (stat.isSymbolicLink()) {
      throw new CliError(`Refusing to read ${this.path}: it is a symbolic link.`, 1, { code: 'CONFIG_DIR_UNSAFE' });
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, servers: {} };
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
      if (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object') {
        return { version: 1, servers: parsed.servers };
      }
    } catch {
      // A damaged file is treated as empty; the next sign-in rewrites it.
    }
    return { version: 1, servers: {} };
  }

  private write(file: CredentialsFile): void {
    if (Object.keys(file.servers).length === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    const tmp = join(this.dir, `.credentials.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      if (!IS_WINDOWS) chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}
