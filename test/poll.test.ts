import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolOutcome } from '../src/envelope.js';
import { CliError, OutcomeUnknownError } from '../src/errors.js';
import { MAX_TRANSIENT_POLL_FAILURES, POLL_WAIT_SEC, isTransientPollFailure, pollInterval, waitForRun, waitForRuns } from '../src/poll.js';

// Failure shapes as the server's normalizeFailure emits them.
const fail = (code: string, error: string, extra: Record<string, unknown> = {}) =>
  outcome({ status: 'failed', code, error, ...extra }, true);

const outcome = (payload: Record<string, unknown>, isError = false): ToolOutcome => ({ payload, isError, links: [] });

describe('waitForRun', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a completed result at once without polling', async () => {
    const call = vi.fn();
    const first = outcome({ status: 'completed', assetUrl: 'https://cdn.aitopia.ai/a.png' });
    await expect(waitForRun(call, first)).resolves.toBe(first);
    expect(call).not.toHaveBeenCalled();
  });

  it('long-polls get_run_status (wait 20) at once, then sleeps only the rest of pollAfterMs', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(outcome({ status: 'running', progress: 40, pollAfterMs: 3000 }))
      .mockResolvedValueOnce(outcome({ status: 'completed', assetUrl: 'https://cdn.aitopia.ai/v.mp4' }));
    const progress: Array<number | null> = [];
    const promise = waitForRun(call, outcome({ status: 'running', runToken: 'tok', pollAfterMs: 5000 }), {
      onProgress: (p) => progress.push(p.progress),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenLastCalledWith('get_run_status', { runToken: 'tok', wait: POLL_WAIT_SEC }, undefined);
    await vi.advanceTimersByTimeAsync(2999);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const done = await promise;

    expect(call).toHaveBeenCalledTimes(2);
    expect(done.payload).toMatchObject({ status: 'completed', runToken: 'tok' });
    expect(progress).toEqual([null, 40]);
    // Only get_run_status was ever called: the generation tool is never re-called.
    expect(call.mock.calls.every(([name]) => name === 'get_run_status')).toBe(true);
  });

  it('asks again at once when the server already held the call for the whole interval', async () => {
    let clock = 0;
    const call = vi
      .fn()
      .mockImplementationOnce(async () => {
        clock += 20_000; // the server waited 20 s
        return outcome({ status: 'running', pollAfterMs: 8000 });
      })
      .mockResolvedValueOnce(outcome({ status: 'completed' }));
    const sleep = vi.fn(async () => undefined);
    const done = await waitForRun(call, outcome({ status: 'running', runToken: 'tok' }), { sleep, now: () => clock });
    expect(done.payload.status).toBe('completed');
    expect(call).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('passes the progress callback to every status call', async () => {
    const call = vi.fn().mockResolvedValueOnce(outcome({ status: 'completed' }));
    const onProgress = vi.fn();
    await waitForRun(call, outcome({ status: 'running', runToken: 'tok' }), { callOptions: { onProgress } });
    expect(call.mock.calls[0]?.[2]).toEqual({ onProgress });
  });

  it('returns a failed poll result for the caller to map', async () => {
    const call = vi.fn().mockResolvedValueOnce(outcome({ status: 'failed', code: 'RUN_LOST', error: 'lost' }, true));
    const promise = waitForRun(call, outcome({ status: 'running', runToken: 'tok' }));
    await vi.advanceTimersByTimeAsync(8000);
    const done = await promise;
    expect(done.isError).toBe(true);
    expect(done.payload.code).toBe('RUN_LOST');
  });

  it('stops with exit 5 and never calls anything when runToken is missing', async () => {
    const call = vi.fn();
    const first = outcome({ status: 'running', resumable: false, note: 'Cannot be tracked from here.' });
    const error = await waitForRun(call, first).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as CliError).exitCode).toBe(5);
    expect((error as CliError).code).toBe('NOT_RESUMABLE');
    expect((error as CliError).message).toBe('Cannot be tracked from here.');
    expect(call).not.toHaveBeenCalled();
  });

  it('tolerates brief network failures while polling', async () => {
    const netError = new CliError('Cannot reach host', 1, { code: 'NETWORK' });
    const call = vi
      .fn()
      .mockRejectedValueOnce(netError)
      .mockResolvedValueOnce(outcome({ status: 'completed' }));
    const promise = waitForRun(call, outcome({ status: 'running', runToken: 'tok', pollAfterMs: 2000 }));
    await vi.advanceTimersByTimeAsync(4000);
    await expect(promise).resolves.toMatchObject({ payload: { status: 'completed' } });
  });

  it('gives up after repeated network failures with exit 5 and the runToken', async () => {
    const call = vi.fn().mockImplementation(() => Promise.reject(new CliError('Cannot reach host', 1, { code: 'NETWORK' })));
    const promise = waitForRun(call, outcome({ status: 'running', runToken: 'tok', pollAfterMs: 2000 })).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000 * MAX_TRANSIENT_POLL_FAILURES);
    const error = (await promise) as CliError;
    expect(call).toHaveBeenCalledTimes(MAX_TRANSIENT_POLL_FAILURES);
    expect(error.exitCode).toBe(5);
    expect(error.notes.join('\n')).toContain('aitopia status tok --wait');
  });

  it('asks again after a status-call 5xx (hint names get_run_status) and RATE_LIMIT, honoring retryAfterSeconds', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        fail('UPSTREAM_5XX', 'Bad gateway', { retryable: true, hint: 'The run is not affected; call get_run_status again with the same runToken in a few seconds.' }),
      )
      .mockResolvedValueOnce(fail('RATE_LIMIT', 'Too many requests', { retryable: true, retryAfterSeconds: 10 }))
      .mockResolvedValueOnce(outcome({ status: 'completed', assetUrl: 'https://cdn.aitopia.ai/v.mp4' }));
    const promise = waitForRun(call, outcome({ status: 'running', runToken: 'tok', pollAfterMs: 2000 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({ payload: { status: 'completed' } });
  });

  it('reports RUN_STALE as a terminal failure, never polled again', async () => {
    const call = vi.fn().mockResolvedValueOnce(fail('RUN_STALE', 'This run has not finished 2 hours after it started.', { retryable: false }));
    const done = await waitForRun(call, outcome({ status: 'running', runToken: 'old' }));
    expect(done.payload.code).toBe('RUN_STALE');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('treats RUN_INTERRUPTED as outcome unknown and RUN_LOST as a failure', async () => {
    const interrupted = vi.fn().mockResolvedValueOnce(
      fail('RUN_INTERRUPTED', 'The server restarted while this was running. A generation may still finish and appear in AITOPIA; check there before running it again.', { retryable: true }),
    );
    const p1 = waitForRun(interrupted, outcome({ status: 'running', runToken: 'a' })).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(8000);
    expect(((await p1) as CliError).exitCode).toBe(5);

    const lost = vi.fn().mockResolvedValueOnce(fail('RUN_LOST', 'This run stopped without a result.', { retryable: true }));
    const p2 = waitForRun(lost, outcome({ status: 'running', runToken: 'b' }));
    await vi.advanceTimersByTimeAsync(8000);
    await expect(p2).resolves.toMatchObject({ isError: true, payload: { code: 'RUN_LOST' } });
    expect(lost).toHaveBeenCalledTimes(1);
  });
});

describe('isTransientPollFailure', () => {
  it('retries only status-call trouble: RATE_LIMIT, and UPSTREAM_5XX whose hint names get_run_status', () => {
    const pollHint = { hint: 'The run is not affected; call get_run_status again with the same runToken in a few seconds.' };
    expect(isTransientPollFailure(fail('RATE_LIMIT', 'x', { retryable: true }))).toBe(true);
    expect(isTransientPollFailure(fail('UPSTREAM_5XX', 'x', { retryable: true, ...pollHint }))).toBe(true);
    // A failed answer is the run's real outcome otherwise.
    expect(isTransientPollFailure(fail('UPSTREAM_5XX', 'x', { retryable: true }))).toBe(false);
    expect(isTransientPollFailure(fail('TIMEOUT', 'x', { retryable: true }))).toBe(false);
    expect(isTransientPollFailure(fail('FAILED', 'x', { retryable: true }))).toBe(false);
    expect(isTransientPollFailure(fail('FAILED', 'x'))).toBe(false);
    expect(isTransientPollFailure(fail('RUN_LOST', 'x', { retryable: true }))).toBe(false);
    expect(isTransientPollFailure(fail('NOT_FOUND', 'x'))).toBe(false);
    expect(isTransientPollFailure(outcome({ status: 'running' }))).toBe(false);
  });
});

describe('pollInterval', () => {
  it('defaults to 8 s and never goes below 2 s', () => {
    expect(pollInterval(undefined)).toBe(8000);
    expect(pollInterval(500)).toBe(2000);
    expect(pollInterval(12000)).toBe(12000);
    expect(pollInterval('3000')).toBe(8000);
  });
});

describe('waitForRuns', () => {
  const sleep = async () => undefined;

  it('polls several runTokens in one long-poll call and maps answers back by position', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        outcome({
          status: 'running',
          items: [
            { index: 0, status: 'completed', assetUrl: 'https://cdn.aitopia.ai/a.png' },
            { index: 1, status: 'running', etaSeconds: 30 },
            { index: 2, status: 'failed', code: 'INVALID_RUN_TOKEN', error: 'Invalid, expired or unrecognized runToken.' },
          ],
          pollAfterMs: 5000,
        }),
      )
      .mockResolvedValueOnce(outcome({ status: 'completed', items: [{ index: 0, status: 'completed', assetUrl: 'https://cdn.aitopia.ai/b.mp4' }] }));
    const ended: string[] = [];
    const ends = await waitForRuns(call, ['a', 'b', 'c'], { untilDone: true, sleep, onEnd: (t) => void ended.push(t) });
    expect(call.mock.calls[0]?.[1]).toEqual({ runTokens: ['a', 'b', 'c'], wait: POLL_WAIT_SEC });
    expect(call.mock.calls[1]?.[1]).toEqual({ runTokens: ['b'], wait: POLL_WAIT_SEC });
    expect(ended).toEqual(['a', 'c', 'b']);
    expect(ends.get('b')).toMatchObject({ state: 'done', payload: { runToken: 'b', assetUrl: 'https://cdn.aitopia.ai/b.mp4' } });
    expect(ends.get('c')).toMatchObject({ state: 'done', isError: true, payload: { code: 'INVALID_RUN_TOKEN' } });
  });

  it('a waitNote answer (checked once, at once) is reported and the client waits pollAfterMs', async () => {
    const note = '3 waiting status checks are already open for your account, so this one checked once without waiting.';
    const call = vi
      .fn()
      .mockResolvedValueOnce(outcome({ status: 'running', items: [{ index: 0, status: 'running' }], pollAfterMs: 6000, waitNote: note }))
      .mockResolvedValueOnce(outcome({ status: 'completed', items: [{ index: 0, status: 'completed' }] }));
    const sleeps: number[] = [];
    const notes: string[] = [];
    await waitForRuns(call, ['a'], { untilDone: true, sleep: async (ms) => void sleeps.push(ms), now: () => 0, onNote: (n) => void notes.push(n) });
    expect(notes).toEqual([note]);
    expect(sleeps).toEqual([6000]);
  });

  it('no answer at all (rate limit / network) on a single check is "no_answer", not still running', async () => {
    const call = vi.fn().mockResolvedValueOnce(fail('RATE_LIMIT', 'Rate limit exceeded for this tool.', { retryable: true }));
    const ends = await waitForRuns(call, ['a', 'b'], { untilDone: false, sleep });
    expect(ends.get('a')).toMatchObject({ state: 'unknown', reason: 'no_answer' });
    expect(ends.get('b')).toMatchObject({ state: 'unknown', reason: 'no_answer' });
  });

  it('checks once without waiting when untilDone is false', async () => {
    const call = vi.fn().mockResolvedValueOnce(outcome({ status: 'running', items: [{ index: 0, status: 'running' }] }));
    const ends = await waitForRuns(call, ['a'], { untilDone: false, sleep });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toEqual({ runTokens: ['a'], wait: 0 });
    expect(ends.get('a')?.state).toBe('unknown');
  });

  it('treats an interrupted item as unknown and gives up after repeated transient failures', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(outcome({ status: 'partial', items: [{ index: 0, status: 'failed', code: 'RUN_INTERRUPTED', error: 'restarted' }, { index: 1, status: 'running' }] }))
      .mockImplementation(() => Promise.reject(new CliError('Cannot reach host', 1, { code: 'NETWORK' })));
    const ends = await waitForRuns(call, ['a', 'b'], { untilDone: true, sleep });
    expect(ends.get('a')?.state).toBe('unknown');
    expect(ends.get('b')?.state).toBe('unknown');
    expect(call).toHaveBeenCalledTimes(1 + MAX_TRANSIENT_POLL_FAILURES);
  });
});
