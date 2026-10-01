import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configDir, type Env } from './config.js';

/**
 * Plans kept by `aitopia edit --dry-run`, so `--plan <token>` runs the plan that
 * was priced on the file that was uploaded for it (a local file is not uploaded
 * again: the server only runs a plan for the same file URL and instruction).
 * The server keeps a plan 1 hour; entries here are dropped after that.
 */
export interface KeptPlan {
  assetUrl: string;
  instruction: string;
  /** The local file (absolute path) or the URL that was given. */
  source: string;
  /** Local files: size and mtime when uploaded, so a changed file is not run with an old plan. */
  size?: number;
  mtimeMs?: number;
  expiresAt: number;
}

type PlanFile = Record<string, KeptPlan>;

const FILE = 'edit-plans.json';

function planPath(env: Env): string {
  return join(configDir(env), FILE);
}

function read(env: Env, now: number): PlanFile {
  try {
    const parsed = JSON.parse(readFileSync(planPath(env), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const live: PlanFile = {};
    for (const [token, plan] of Object.entries(parsed as PlanFile)) {
      if (plan && typeof plan.assetUrl === 'string' && typeof plan.expiresAt === 'number' && plan.expiresAt > now) live[token] = plan;
    }
    return live;
  } catch {
    return {};
  }
}

/** The key a source is kept under: an absolute path for a file, the URL as given otherwise. */
export function sourceKey(source: string, remote: boolean): string {
  return remote ? source : resolve(source);
}

/** Size and mtime of a local file (undefined for a URL). */
export function fileStamp(source: string, remote: boolean): { size?: number; mtimeMs?: number } {
  if (remote) return {};
  const st = statSync(source);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

/** Keeps a dry run's plan. Best effort: a read-only config directory only loses the shortcut. */
export function keepPlan(token: string, plan: Omit<KeptPlan, 'expiresAt'>, ttlSec: number, env: Env = process.env, now = Date.now()): boolean {
  try {
    const plans = read(env, now);
    plans[token] = { ...plan, expiresAt: now + ttlSec * 1000 };
    mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
    const tmp = `${planPath(env)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(plans, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, planPath(env));
    return true;
  } catch {
    return false;
  }
}

/** The kept plan for a token, if it is still valid. */
export function keptPlan(token: string, env: Env = process.env, now = Date.now()): KeptPlan | undefined {
  return read(env, now)[token];
}
