import { describe, expect, it } from 'vitest';
import {
  BUY_CREDITS_URL,
  CliError,
  EXIT,
  NOTHING_CHARGED_HINT,
  exitCodeFor,
  failureToError,
  NotSignedInError,
  OutcomeUnknownError,
  RECONNECT_APP_HINT,
  runLimitNotes,
  runLimitOf,
  toCliError,
  UsageError,
} from '../src/errors.js';

describe('exit codes', () => {
  it('maps server codes', () => {
    expect(exitCodeFor('SESSION_EXPIRED', 'Your AITOPIA sign-in has ended. Sign in to AITOPIA again, then retry.')).toBe(3);
    expect(exitCodeFor('SESSION_UNAVAILABLE', 'Could not read your AITOPIA balance. Reconnect the AITOPIA connector (re-authorize) so a fresh session is captured, then retry.')).toBe(3);
    expect(exitCodeFor('SESSION_EXPIRED', 'This tool needs your AITOPIA session to run. Reconnect the AITOPIA connector (re-authorize) so a fresh session is captured, then retry.')).toBe(3);
    expect(exitCodeFor('INSUFFICIENT_CREDITS')).toBe(4);
    for (const code of ['RATE_LIMIT', 'TIMEOUT', 'NOT_FOUND', 'INVALID_INPUT', 'RUN_LOST', 'FAILED', undefined]) {
      expect(exitCodeFor(code)).toBe(1);
    }
  });

  it('uses 2 for usage, 3 for sign-in', () => {
    expect(new UsageError('x').exitCode).toBe(EXIT.USAGE);
    expect(new NotSignedInError().exitCode).toBe(EXIT.AUTH);
    expect(new NotSignedInError().message).toBe('Not signed in. Run `aitopia login`.');
  });
});

describe('failureToError', () => {
  it('shows required and available credits with the buy link', () => {
    const error = failureToError(
      { status: 'failed', code: 'INSUFFICIENT_CREDITS', error: 'Insufficient credits', details: { requiredCredits: 120, availableCredits: 30 } },
      { buyCreditsUrl: 'https://aitopia.ai/pricing' },
    );
    expect(error.exitCode).toBe(4);
    expect(error.notes).toEqual(['This run needs 120, you have 30 credits.', 'Buy credits: https://aitopia.ai/pricing']);
  });

  it('points to login only for the AITOPIA sign-in itself', () => {
    const error = failureToError({
      status: 'failed',
      code: 'SESSION_EXPIRED',
      error: 'Your AITOPIA sign-in has ended. Sign in to AITOPIA again, then retry.',
      retryable: true,
    });
    expect(error.exitCode).toBe(3);
    expect(error.hint).toBe('Run `aitopia login`.');
  });

  it('keeps third-party auth failures at exit 1 with a reconnect hint', () => {
    // Composio: "reconnect your Gmail" is inferred as SESSION_EXPIRED by the server.
    const gmail = failureToError({ status: 'failed', code: 'SESSION_EXPIRED', error: 'Gmail connection expired. Please reconnect your Gmail account.', retryable: false });
    expect(gmail.exitCode).toBe(1);
    expect(gmail.code).toBe('SESSION_EXPIRED');
    expect(gmail.hint).toBe(RECONNECT_APP_HINT);
    // Shopify: "Unauthorized" is inferred as UNAUTHENTICATED.
    const shopify = failureToError({ status: 'failed', code: 'UNAUTHENTICATED', error: '[API] Invalid API key or access token (unrecognized login or wrong password) Unauthorized' });
    expect(shopify.exitCode).toBe(1);
    expect(shopify.hint).toBe(RECONNECT_APP_HINT);
  });

  it('keeps error + hint for other codes and adds retry time', () => {
    const error = failureToError({ status: 'failed', code: 'RATE_LIMIT', error: 'Too many requests', hint: 'Wait a bit', retryAfterSeconds: 12.2 });
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe('Too many requests');
    expect(error.hint).toBe('Wait a bit');
    expect(error.notes).toContain('Try again in 13 s.');
  });

  it('defaults a missing code to FAILED', () => {
    const error = failureToError({ status: 'failed' });
    expect(error.code).toBe('FAILED');
    expect(error.message).toBe('The tool failed.');
  });
});

describe('toCliError', () => {
  it('reports network failures in one line with the host', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND mcp.aitopia.ai'), { code: 'ENOTFOUND' });
    const error = toCliError(new TypeError('fetch failed', { cause }), 'https://mcp.aitopia.ai/mcp');
    expect(error.message).toBe('Cannot reach mcp.aitopia.ai (ENOTFOUND).');
    expect(error.exitCode).toBe(1);
  });

  it('treats HTTP 401 and UnauthorizedError as an expired session', () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' });
    expect(toCliError(unauthorized).exitCode).toBe(3);
    expect(toCliError(Object.assign(new Error('401'), { code: 401 })).exitCode).toBe(3);
  });

  it('turns an MCP request timeout into exit 5 (outcome unknown)', () => {
    const error = toCliError(Object.assign(new Error('Request timed out'), { code: -32001 }));
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error.exitCode).toBe(EXIT.PENDING);
    expect(error.notes.join(' ')).toMatch(/before running it again/);
  });

  it('names the runToken for an unknown outcome', () => {
    const error = new OutcomeUnknownError('Lost contact.', { runToken: 'tok' });
    expect(error.exitCode).toBe(5);
    expect(error.notes).toContain('Check it with: aitopia status tok --wait');
    expect(error.data.runToken).toBe('tok');
  });

  it('passes CliErrors through', () => {
    const original = new CliError('boom', 4);
    expect(toCliError(original)).toBe(original);
  });
});

describe('new server codes', () => {
  it('SLOT_TIMEOUT / BATCH_UNAVAILABLE / MODEL_CHECK_UNAVAILABLE: exit 1, nothing charged, safe to retry', () => {
    for (const code of ['SLOT_TIMEOUT', 'BATCH_UNAVAILABLE', 'MODEL_CHECK_UNAVAILABLE']) {
      const error = failureToError({ status: 'failed', code, error: 'Not started.', retryable: true });
      expect(error.exitCode).toBe(1);
      expect(error.hint).toBe(NOTHING_CHARGED_HINT);
    }
  });

  it('MODEL_NOT_ALLOWED lists suggestions (objects or ids) and explains allowAnyModel', () => {
    const error = failureToError({
      status: 'failed',
      code: 'MODEL_NOT_ALLOWED',
      error: '"old/model" is not one of AITOPIA\'s recommended image models.',
      suggestions: [{ id: 'google/nano-banana-2', displayName: 'Nano Banana 2', mediaType: 'image' }, 'acme/other'],
    });
    expect(error.exitCode).toBe(1);
    expect(error.notes).toContain('Did you mean: google/nano-banana-2 (Nano Banana 2), acme/other');
    expect(error.hint).toContain('"allowAnyModel": true');
  });

  it('RUN_STALE finds the creations link under details', () => {
    const error = failureToError({ status: 'failed', code: 'RUN_STALE', error: 'Not finished after 2 hours.', details: { openInAitopia: 'https://aitopia.ai/creations' } });
    expect(error.exitCode).toBe(1);
    expect(error.notes).toContain('Open in AITOPIA: https://aitopia.ai/creations');
  });

  it('INVALID_RUN_TOKEN and the single-token NOT_FOUND read the same', () => {
    const a = failureToError({ status: 'failed', code: 'INVALID_RUN_TOKEN', error: 'Invalid, expired or unrecognized runToken.' });
    const b = failureToError({ status: 'failed', code: 'NOT_FOUND', error: 'Invalid, expired or unrecognized runToken.' });
    expect(a.message).toBe('This run token is not valid.');
    expect(b.message).toBe(a.message);
    expect(b.hint).toBe(a.hint);
    // An ordinary NOT_FOUND keeps its own text.
    expect(failureToError({ status: 'failed', code: 'NOT_FOUND', error: 'Unknown tool x' }).message).toBe('Unknown tool x');
  });
});

describe('broken connections after a paid call', () => {
  const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });

  it('ECONNRESET / socket errors / HTTP 5xx / a dropped stream after a paid call: exit 5, check before running again', () => {
    for (const error of [
      reset,
      Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      Object.assign(new Error('Error POSTing to endpoint (HTTP 502)'), { code: 502 }),
      Object.assign(new Error('Error POSTing to endpoint (HTTP 504)'), { code: 504 }),
      new Error('SSE stream disconnected: TypeError: terminated'),
    ]) {
      const mapped = toCliError(error, 'https://mcp.aitopia.ai/mcp', { paid: true });
      expect(mapped.exitCode).toBe(EXIT.PENDING);
      expect(mapped.notes.join(' ')).toContain('may have reached AITOPIA');
    }
  });

  it('errors before the request could reach the server stay exit 1 (safe to retry)', () => {
    expect(toCliError(refused, undefined, { paid: true }).exitCode).toBe(1);
    expect(toCliError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), undefined, { paid: true }).exitCode).toBe(1);
    expect(toCliError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }), undefined, { paid: true }).exitCode).toBe(1);
  });

  it('free calls keep "try again"', () => {
    expect(toCliError(reset).exitCode).toBe(1);
    expect(toCliError(Object.assign(new Error('HTTP 502'), { code: 502 })).message).toContain('Try again');
  });

  it('batch items: requiredCredits at the top level still shows the needed credits', () => {
    const error = failureToError({ status: 'failed', code: 'INSUFFICIENT_CREDITS', error: 'Not enough credits', requiredCredits: 40, availableCredits: 3 });
    expect(error.notes).toContain('This run needs 40, you have 3 credits.');
  });
});

describe('run limits', () => {
  const SUSPENDED = 'Your access to generation has been suspended.\nIf you believe this is a mistake, contact info@aitopia.ai.';
  const TIMED = 'You started too many runs in a short time.\nRuns are paused for this account for a while.';
  // 2026-10-05 12:00:00 local time.
  const now = () => new Date(2026, 9, 5, 12, 0, 0).getTime();

  it('scotty envelope RUN_LIMITED: the message verbatim with its line breaks, exit 6, no hint of our own', () => {
    const error = failureToError(
      { status: 'failed', code: 'RUN_LIMITED', error: SUSPENDED, reason: 'abuse_limit', retryable: false, upgrade: false, hint: 'Tell the user to contact support.' },
      { now },
    );
    expect(error.message).toBe(SUSPENDED);
    expect(error.exitCode).toBe(EXIT.RUN_LIMITED);
    expect(error.exitCode).toBe(6);
    expect(error.code).toBe('RUN_LIMITED');
    expect(error.hint).toBeUndefined();
    expect(error.notes).toEqual([]);
    expect(error.data.runLimit).toEqual({ code: 'RUN_LIMITED', reason: 'abuse_limit', message: SUSPENDED, upgrade: false });
  });

  it('scotty envelope QUEUE_LIMIT_EXCEEDED + reason abuse_limit is a run limit, not the "too many runs" hint', () => {
    const error = failureToError({ status: 'failed', code: 'QUEUE_LIMIT_EXCEEDED', reason: 'abuse_limit', error: SUSPENDED, retryable: false, upgrade: false });
    expect(error.message).toBe(SUSPENDED);
    expect(error.exitCode).toBe(6);
    expect(error.code).toBe('RUN_LIMITED');
    expect(error.hint).toBeUndefined();
    expect((error.data.runLimit as { code: string }).code).toBe('QUEUE_LIMIT_EXCEEDED');
  });

  it('raw passthrough { runLimit: {...} } (also under details, as normalizeFailure moves it)', () => {
    const runLimit = { code: 'QUEUE_LIMIT_EXCEEDED', reason: 'abuse_limit', error: SUSPENDED, upgrade: false };
    for (const payload of [{ runLimit }, { status: 'failed', code: 'FAILED', error: 'x', details: { runLimit } }]) {
      const error = failureToError(payload, { now });
      expect(error.message).toBe(SUSPENDED);
      expect(error.exitCode).toBe(6);
      expect(error.notes).toEqual([]);
    }
  });

  it('timed variant: retryAfterSeconds becomes minutes and a clock time', () => {
    const error = failureToError({ runLimit: { code: 'QUEUE_LIMIT_EXCEEDED', reason: 'abuse_limit', error: TIMED, upgrade: false, retryAfterSeconds: 1794 } }, { now });
    expect(error.message).toBe(TIMED);
    expect(error.notes).toEqual(['You can try again in 30 minutes (at 12:29).']);
    const one = failureToError({ status: 'failed', code: 'RUN_LIMITED', error: TIMED, retryAfterSeconds: 20 }, { now });
    expect(one.notes).toEqual(['You can try again in 1 minute (at 12:00).']);
  });

  it('upgrade true adds the plan link (the existing pricing URL); false adds nothing', () => {
    const up = failureToError({ status: 'failed', code: 'RUN_LIMITED', error: TIMED, upgrade: true, retryAfterSeconds: 600 }, { now });
    expect(up.notes).toEqual(['You can try again in 10 minutes (at 12:10).', `Upgrading your AITOPIA plan lifts this limit: ${BUY_CREDITS_URL}`]);
    const down = failureToError({ status: 'failed', code: 'RUN_LIMITED', error: SUSPENDED, upgrade: false });
    expect(down.notes).toEqual([]);
  });

  it('normalized runLimit with message (balance / dry-run shape) and new reasons are passed through', () => {
    const limit = runLimitOf({ creditsForGeneration: 10, runLimit: { code: 'RUN_LIMITED', reason: 'some_new_reason', message: 'New text.\nSecond line.', upgrade: true } });
    expect(limit).toEqual({ code: 'RUN_LIMITED', reason: 'some_new_reason', message: 'New text.\nSecond line.', upgrade: true });
    expect(runLimitOf({ status: 'estimate', balance: { creditsForGeneration: 3, runLimit: { message: 'Paused.' } } })?.message).toBe('Paused.');
    expect(runLimitNotes({ code: 'RUN_LIMITED', message: 'x', upgrade: true }, { buyCreditsUrl: 'https://aitopia.ai/x' })).toEqual([
      'Upgrading your AITOPIA plan lifts this limit: https://aitopia.ai/x',
    ]);
  });

  it('a plain QUEUE_LIMIT_EXCEEDED (no reason, or another reason) keeps its meaning', () => {
    for (const payload of [
      { status: 'failed', code: 'QUEUE_LIMIT_EXCEEDED', error: 'Too many runs at once.' },
      { status: 'failed', code: 'QUEUE_LIMIT_EXCEEDED', reason: 'concurrency', error: 'Too many runs at once.' },
    ]) {
      expect(runLimitOf(payload)).toBeUndefined();
      const error = failureToError(payload);
      expect(error.code).toBe('QUEUE_LIMIT_EXCEEDED');
      expect(error.exitCode).toBe(1);
      expect(error.message).toBe('Too many runs at once.');
      expect(error.hint).toContain('aitopia status');
    }
    expect(exitCodeFor('QUEUE_LIMIT_EXCEEDED')).toBe(1);
    expect(exitCodeFor('RUN_LIMITED')).toBe(6);
  });
});
