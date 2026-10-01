import { CliError, OutcomeUnknownError, failureToError, networkErrorCode } from './errors.js';
import { statusOf, type ToolOutcome } from './envelope.js';
import type { CallOptions, ToolCaller } from './mcp.js';

/** Seconds get_run_status may hold each call open server-side (its maximum). */
export const POLL_WAIT_SEC = 20;
/** Most runTokens one get_run_status call accepts. */
export const MAX_RUN_TOKENS = 12;
export const DEFAULT_POLL_MS = 8000;
export const MIN_POLL_MS = 2000;
/** Longest wait honored from a server's retryAfterSeconds. */
export const MAX_RETRY_WAIT_MS = 60_000;
/** Consecutive transient poll failures (network, timeout, rate limit) tolerated before giving up. */
export const MAX_TRANSIENT_POLL_FAILURES = 5;

const WAITING_STATUSES = new Set(['running', 'queued', 'pending', 'processing', 'starting', 'in_progress']);

/** get_run_status failures that say nothing about the run itself: ask again. */
/** Terminal answers even when marked retryable (retryable there means "run it again"). */
const TERMINAL_CODES = new Set([
  'RUN_LOST',
  'RUN_INTERRUPTED',
  'NOT_FOUND',
  'INSUFFICIENT_CREDITS',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'SESSION_UNAVAILABLE',
  'INVALID_INPUT',
  'INVALID_RUN_TOKEN',
  'RUN_STALE',
]);
/** Terminal answers after which the result may still appear in AITOPIA. */
const UNKNOWN_OUTCOME_CODES = new Set(['RUN_INTERRUPTED']);

export function isRunning(outcome: ToolOutcome): boolean {
  return !outcome.isError && WAITING_STATUSES.has(statusOf(outcome));
}

export function pollInterval(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(MIN_POLL_MS, value) : DEFAULT_POLL_MS;
}

function codeOf(outcome: ToolOutcome): string | undefined {
  return typeof outcome.payload.code === 'string' ? outcome.payload.code.toUpperCase() : undefined;
}

/**
 * A failed get_run_status answer worth asking again. The server already turns
 * slow or failing provider polls into "running", so a "failed" answer is the
 * run's real outcome, except: RATE_LIMIT (the status call itself was refused;
 * it says nothing about the run) and UPSTREAM_5XX whose hint says to call
 * get_run_status again (a gateway error on the poll). TIMEOUT or
 * retryable: true alone are outcomes ("run it again"), not poll trouble.
 */
export function isTransientPollFailure(outcome: ToolOutcome): boolean {
  if (!outcome.isError && outcome.payload.status !== 'failed') return false;
  const code = codeOf(outcome);
  if (!code || TERMINAL_CODES.has(code)) return false;
  if (code === 'RATE_LIMIT') return true;
  const hint = typeof outcome.payload.hint === 'string' ? outcome.payload.hint : '';
  return code === 'UPSTREAM_5XX' && /get_run_status/.test(hint);
}

export interface RunProgress {
  runToken: string;
  progress: number | null;
  queuePosition?: number;
  etaSeconds?: number;
}

export interface WaitOptions {
  /** Called once with the runToken when waiting starts. */
  onStart?: (runToken: string) => void;
  onProgress?: (progress: RunProgress) => void;
  /** Every answer while the run is still going (the first one too), e.g. to follow a step plan. */
  onUpdate?: (payload: Record<string, unknown>) => void;
  /** Live progress notifications of each status call. */
  callOptions?: CallOptions;
  /** Server notes about the call itself (e.g. waitNote: it checked once without waiting). */
  onNote?: (note: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function progressOf(runToken: string, outcome: ToolOutcome): RunProgress {
  const p = outcome.payload;
  return {
    runToken,
    progress: numberOrUndefined(p.progress) ?? null,
    queuePosition: numberOrUndefined(p.queuePosition),
    etaSeconds: numberOrUndefined(p.etaSeconds),
  };
}

function isNetworkFailure(error: unknown): boolean {
  return Boolean(networkErrorCode(error)) || (error instanceof CliError && (error.code === 'NETWORK' || error.code === 'TIMEOUT'));
}

/** Wait before the next status call: the rest of pollAfterMs, nothing when the call itself long-polled that long. */
export function nextDelay(intervalMs: number, callMs: number): number {
  return Math.max(0, intervalMs - callMs);
}

/**
 * Follows a long run to its end. `first` is what the generation tool answered.
 * Only get_run_status is ever called here: the generation tool is never called
 * again (a new call would be a new, charged run). Each call long-polls on the
 * server (`wait`), so the client sleeps only when an answer comes back early.
 * When the outcome cannot be learned, an OutcomeUnknownError (exit 5) names
 * the runToken.
 */
export async function waitForRun(call: ToolCaller, first: ToolOutcome, options: WaitOptions = {}): Promise<ToolOutcome> {
  if (!isRunning(first)) return first;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const runToken = first.payload.runToken;
  if (typeof runToken !== 'string' || !runToken) {
    const note =
      typeof first.payload.note === 'string' && first.payload.note
        ? first.payload.note
        : 'The run was submitted but cannot be tracked from here; it will appear in AITOPIA when it finishes.';
    throw new OutcomeUnknownError(note, { code: 'NOT_RESUMABLE', data: { ...first.payload } });
  }

  options.onStart?.(runToken);
  options.onUpdate?.(first.payload);
  options.onProgress?.(progressOf(runToken, first));
  let interval = pollInterval(first.payload.pollAfterMs);
  let delay = 0;
  let transientFailures = 0;
  const giveUp = (reason: string) =>
    new OutcomeUnknownError(`${reason} The run may still finish in AITOPIA.`, { runToken, code: 'OUTCOME_UNKNOWN' });

  for (;;) {
    if (delay > 0) await sleep(delay);
    const started = now();
    let next: ToolOutcome;
    try {
      next = await call('get_run_status', { runToken, wait: POLL_WAIT_SEC }, options.callOptions);
    } catch (error) {
      if (!isNetworkFailure(error)) {
        if (error instanceof CliError) {
          error.notes.push(`The run may still finish. Check it with: aitopia status ${runToken} --wait`);
          Object.assign(error.data, { runToken });
        }
        throw error;
      }
      transientFailures += 1;
      if (transientFailures >= MAX_TRANSIENT_POLL_FAILURES) throw giveUp('Lost contact with AITOPIA while waiting.');
      delay = interval;
      continue;
    }

    if (isTransientPollFailure(next)) {
      transientFailures += 1;
      if (transientFailures >= MAX_TRANSIENT_POLL_FAILURES) throw giveUp('AITOPIA could not report the run status.');
      delay = retryDelay(next, interval);
      continue;
    }
    transientFailures = 0;

    if (!isRunning(next)) {
      const code = codeOf(next);
      if (code && UNKNOWN_OUTCOME_CODES.has(code)) {
        const message = typeof next.payload.error === 'string' ? next.payload.error : 'The run was interrupted.';
        throw new OutcomeUnknownError(message, { runToken, code, data: { ...next.payload } });
      }
      return { ...next, payload: { runToken, ...next.payload } };
    }
    if (typeof next.payload.waitNote === 'string') options.onNote?.(next.payload.waitNote);
    options.onUpdate?.(next.payload);
    options.onProgress?.(progressOf(runToken, next));
    interval = pollInterval(next.payload.pollAfterMs ?? interval);
    delay = nextDelay(interval, now() - started);
  }
}

function retryDelay(outcome: ToolOutcome, interval: number): number {
  const retryAfter = numberOrUndefined(outcome.payload.retryAfterSeconds);
  return retryAfter !== undefined ? Math.min(MAX_RETRY_WAIT_MS, Math.max(MIN_POLL_MS, retryAfter * 1000)) : interval;
}

/** How one of several runs ended (see waitForRuns). */
export type RunEnd =
  | { state: 'done'; payload: Record<string, unknown>; isError: boolean }
  /**
   * interrupted: the server restarted during the run; still_running: waiting
   * stopped while it ran; no_answer: AITOPIA could not be asked (network,
   * rate limit), so nothing is known about it.
   */
  | { state: 'unknown'; reason: 'interrupted' | 'still_running' | 'no_answer'; payload: Record<string, unknown> };

export interface MultiWaitOptions {
  /** Keep asking until every run ended (false: one check). */
  untilDone: boolean;
  /** Called as each run ends (awaited, e.g. to download its file at once). */
  onEnd?: (runToken: string, end: RunEnd & { state: 'done' }) => Promise<void> | void;
  /** After every answer: the runs still going and the latest status of each. */
  onRound?: (running: Array<{ runToken: string; payload: Record<string, unknown> }>) => void;
  /** Server notes about the call itself (e.g. waitNote: it checked once without waiting). */
  onNote?: (note: string) => void;
  callOptions?: CallOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Polls several runs with get_run_status `runTokens` (up to 12 per call, each
 * call long-polling on the server). Results come back in request order. Never
 * calls anything else. Returns how every token ended; tokens still running
 * when waiting stops (untilDone false, or contact lost) are `unknown`.
 */
export async function waitForRuns(call: ToolCaller, tokens: string[], options: MultiWaitOptions): Promise<Map<string, RunEnd>> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const ends = new Map<string, RunEnd>();
  const latest = new Map<string, Record<string, unknown>>();
  let pending = [...new Set(tokens)];
  let interval = DEFAULT_POLL_MS;
  let delay = 0;
  let transientFailures = 0;

  const stopAll = (reason: 'still_running' | 'no_answer') => {
    for (const token of pending) {
      const seen = latest.get(token);
      // A run seen running earlier is still running; one never answered for is unknown.
      const why = reason === 'no_answer' && seen ? 'still_running' : reason;
      ends.set(token, { state: 'unknown', reason: why, payload: { runToken: token, status: 'running', ...seen } });
    }
    return ends;
  };

  while (pending.length > 0) {
    if (delay > 0) await sleep(delay);
    const batch = pending.slice(0, MAX_RUN_TOKENS);
    const started = now();
    const args = { runTokens: batch, wait: options.untilDone ? POLL_WAIT_SEC : 0 };
    let answer: ToolOutcome | undefined;
    try {
      answer = await call('get_run_status', args, options.callOptions);
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
    }
    const items = answer && !answer.isError && Array.isArray(answer.payload.items) ? (answer.payload.items as unknown[]) : undefined;
    if (answer && answer.isError && !isTransientPollFailure(answer)) {
      // The call itself was refused (not about any one run).
      throw failureToError(answer.payload);
    }
    if (!answer || !items || answer.isError) {
      transientFailures += 1;
      if (!options.untilDone || transientFailures >= MAX_TRANSIENT_POLL_FAILURES) return stopAll('no_answer');
      delay = answer ? retryDelay(answer, interval) : interval;
      continue;
    }
    transientFailures = 0;
    if (typeof answer.payload.waitNote === 'string') options.onNote?.(answer.payload.waitNote);

    const still: string[] = [];
    for (const [i, token] of batch.entries()) {
      const raw = items[i];
      const item = raw && typeof raw === 'object' ? ({ ...(raw as Record<string, unknown>) } as Record<string, unknown>) : undefined;
      if (!item) {
        // No answer for this run in this round.
        still.push(token);
        continue;
      }
      delete item.index;
      const payload = { runToken: token, ...item };
      latest.set(token, payload);
      const status = typeof item.status === 'string' ? item.status : 'completed';
      if (WAITING_STATUSES.has(status)) {
        still.push(token);
        continue;
      }
      const code = typeof item.code === 'string' ? item.code.toUpperCase() : undefined;
      if (code && UNKNOWN_OUTCOME_CODES.has(code)) {
        ends.set(token, { state: 'unknown', reason: 'interrupted', payload });
        continue;
      }
      const end = { state: 'done' as const, payload, isError: status === 'failed' };
      ends.set(token, end);
      await options.onEnd?.(token, end);
    }
    pending = [...still, ...pending.slice(MAX_RUN_TOKENS)];
    options.onRound?.(pending.map((token) => ({ runToken: token, payload: latest.get(token) ?? { status: 'running' } })));
    if (!options.untilDone) return stopAll('still_running');
    interval = pollInterval(answer.payload.pollAfterMs ?? interval);
    delay = nextDelay(interval, now() - started);
  }
  return ends;
}
