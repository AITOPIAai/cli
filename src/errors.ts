export const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  AUTH: 3,
  CREDITS: 4,
  /** Submitted, but the outcome is not known yet (still running, or the answer was lost). */
  PENDING: 5,
  INTERRUPTED: 130,
} as const;

export const BUY_CREDITS_URL = 'https://aitopia.ai/pricing';
export const LOGIN_HINT = 'Run `aitopia login`.';
export const RECONNECT_APP_HINT = 'A connected app needs reconnecting in AITOPIA. See `aitopia run list_connections`.';

export interface ErrorExtra {
  /** Server error code (e.g. INSUFFICIENT_CREDITS) or a local one (NOT_SIGNED_IN, NETWORK, ...). */
  code?: string;
  hint?: string;
  /** Extra lines shown after the message (links, next steps). */
  notes?: string[];
  /** Fields merged into the --json error object. */
  data?: Record<string, unknown>;
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly hint?: string;
  readonly notes: string[];
  readonly data: Record<string, unknown>;

  constructor(message: string, exitCode: number = EXIT.FAILED, extra: ErrorExtra = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = extra.code ?? 'FAILED';
    this.hint = extra.hint;
    this.notes = extra.notes ?? [];
    this.data = extra.data ?? {};
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.USAGE, { code: 'USAGE', hint });
    this.name = 'UsageError';
  }
}

export class NotSignedInError extends CliError {
  constructor(message = 'Not signed in. Run `aitopia login`.', code = 'NOT_SIGNED_IN') {
    super(message, EXIT.AUTH, { code });
    this.name = 'NotSignedInError';
  }
}

export function statusNotes(runToken: string | string[]): string[] {
  const tokens = Array.isArray(runToken) ? runToken : [runToken];
  if (tokens.length === 1) return [`Run token: ${tokens[0]}`, `Check it with: aitopia status ${tokens[0]} --wait`];
  return [`Run tokens: ${tokens.join(' ')}`, `Check them with: aitopia status ${tokens.join(' ')} --wait`];
}

/**
 * The request reached the server but its outcome is unknown (exit 5). The run
 * may still finish and be charged, so the user must not simply run it again.
 */
export class OutcomeUnknownError extends CliError {
  constructor(message: string, options: { runToken?: string; code?: string; data?: Record<string, unknown> } = {}) {
    const notes = options.runToken
      ? statusNotes(options.runToken)
      : ['Check AITOPIA for the result before running it again.'];
    super(message, EXIT.PENDING, {
      code: options.code ?? 'OUTCOME_UNKNOWN',
      notes,
      data: { ...(options.data ?? {}), ...(options.runToken ? { runToken: options.runToken } : {}) },
    });
    this.name = 'OutcomeUnknownError';
  }
}

export function interruptNotes(runToken?: string | string[]): string[] {
  const tokens = runToken === undefined ? [] : Array.isArray(runToken) ? runToken : [runToken];
  if (tokens.length === 0) return ['The request may still finish in AITOPIA.'];
  const what = tokens.length === 1 ? 'The run keeps' : 'The runs keep';
  return [`${what} going in AITOPIA (not cancelled).`, ...statusNotes(tokens)];
}

const AITOPIA_AUTH_CODES = new Set(['SESSION_EXPIRED', 'SESSION_UNAVAILABLE', 'UNAUTHENTICATED']);
/** Wording of AITOPIA's own session failures (not a third-party app's "reconnect your Gmail"). */
const AITOPIA_AUTH_TEXT = /AITOPIA (?:sign-in|session|connector)|sign-in has ended/i;

/** True when a failure is about the AITOPIA sign-in itself (so `aitopia login` fixes it). */
export function isAitopiaAuthFailure(code: string | undefined, message: string): boolean {
  return code !== undefined && AITOPIA_AUTH_CODES.has(code) && AITOPIA_AUTH_TEXT.test(message);
}

/** Exit code for a server error code and message. */
export function exitCodeFor(code: string | undefined, message = ''): number {
  if (isAitopiaAuthFailure(code, message)) return EXIT.AUTH;
  if (code === 'INSUFFICIENT_CREDITS') return EXIT.CREDITS;
  return EXIT.FAILED;
}

export interface FailurePayload {
  status?: unknown;
  code?: unknown;
  error?: unknown;
  message?: unknown;
  hint?: unknown;
  retryAfterSeconds?: unknown;
  details?: unknown;
  [key: string]: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Turns a server failure payload into a CliError with the right exit code and next steps. */
export function failureToError(payload: FailurePayload, opts: { buyCreditsUrl?: string; openInAitopia?: string } = {}): CliError {
  const code = str(payload.code)?.toUpperCase() ?? 'FAILED';
  const message = str(payload.error) ?? str(payload.message) ?? 'The tool failed.';
  const hint = str(payload.hint);
  const exitCode = exitCodeFor(code, message);
  const notes: string[] = [];
  const data: Record<string, unknown> = { ...payload };

  if (exitCode === EXIT.AUTH) {
    return new CliError(message, exitCode, { code, hint: LOGIN_HINT, notes, data });
  }
  if (AITOPIA_AUTH_CODES.has(code)) {
    // A third-party app's sign-in (Gmail, Shopify, ...), not the AITOPIA one.
    return new CliError(message, exitCode, { code, hint: hint ?? RECONNECT_APP_HINT, notes, data });
  }
  if (code === 'INSUFFICIENT_CREDITS') {
    const details = (payload.details && typeof payload.details === 'object' ? payload.details : {}) as Record<string, unknown>;
    // Single tools put these under details; batch / multi-run items at the top level.
    const required = num(details.requiredCredits) ?? num(payload.requiredCredits);
    const available = num(details.availableCredits) ?? num(payload.availableCredits);
    if (required !== undefined || available !== undefined) {
      const parts: string[] = [];
      if (required !== undefined) parts.push(`needs ${formatNumber(required)}`);
      if (available !== undefined) parts.push(`you have ${formatNumber(available)}`);
      notes.push(`This run ${parts.join(', ')} credits.`);
    }
    const buy = opts.buyCreditsUrl ?? BUY_CREDITS_URL;
    notes.push(`Buy credits: ${buy}`);
    return new CliError('Not enough AITOPIA credits.', exitCode, { code, hint, notes, data });
  }
  if (MODEL_CODES.has(code)) {
    const suggestions = suggestionList(payload.suggestions);
    if (suggestions.length > 0) notes.push(`Did you mean: ${suggestions.join(', ')}`);
    return new CliError(message, exitCode, { code, hint: modelHint(code, payload), notes, data });
  }
  const fixedHint = CODE_HINTS[code] ?? (isRunTokenNotFound(code, message) ? CODE_HINTS.INVALID_RUN_TOKEN : undefined);
  if (fixedHint) {
    const open = opts.openInAitopia ?? detailString(payload, 'openInAitopia');
    if (open) notes.push(`Open in AITOPIA: ${open}`);
    const text = isRunTokenNotFound(code, message) ? 'This run token is not valid.' : message;
    return new CliError(text, exitCode, { code, hint: fixedHint, notes, data });
  }
  const retryAfter = num(payload.retryAfterSeconds);
  if (code === 'RATE_LIMIT' && retryAfter !== undefined) notes.push(`Try again in ${Math.ceil(retryAfter)} s.`);
  if (opts.openInAitopia) notes.push(`Open in AITOPIA: ${opts.openInAitopia}`);
  return new CliError(message, exitCode, { code, hint, notes, data });
}

/** Server codes for a model id the call cannot use (nothing was spent). */
const MODEL_CODES = new Set(['MODEL_NOT_FOUND', 'MODEL_NOT_ALLOWED', 'MODEL_NOT_IN_PLAYBOOK', 'MODEL_KIND_MISMATCH', 'MODEL_REQUIRED']);

export const NOTHING_CHARGED_HINT = 'Nothing was submitted or charged; it is safe to run it again.';

/** CLI wording for server codes whose own hints are written for assistants. */
const CODE_HINTS: Record<string, string> = {
  RUN_STALE: 'If it finished late, the file is in your AITOPIA creations. Otherwise run it again; this run is not checked any further.',
  INVALID_RUN_TOKEN:
    'Run tokens expire after 7 days and only work for the account that started the run. Check that the whole token was copied.',
  SLOT_TIMEOUT: NOTHING_CHARGED_HINT,
  BATCH_UNAVAILABLE: NOTHING_CHARGED_HINT,
  MODEL_CHECK_UNAVAILABLE: NOTHING_CHARGED_HINT,
  PRICE_UNKNOWN: 'Run it without --dry-run only if you accept an unknown price.',
  PLAN_UNAVAILABLE: 'AITOPIA could not plan this edit right now. Nothing was spent; try again later.',
  PLAN_INVALID: 'AITOPIA could not make a workable plan for this. Nothing ran; it is safe to try again, perhaps worded differently.',
  NOT_SUPPORTED: 'AITOPIA cannot make this change to this kind of file yet. Nothing ran or was charged.',
  PLAN_EXPIRED: 'Nothing ran or was charged. Run aitopia edit --dry-run again for a new plan.',
  SERVER_RESTARTING: 'AITOPIA is restarting. Nothing ran; it is safe to try again in a minute.',
};

/** Codes after which running the same thing again is safe (nothing was charged). */
export const NOT_CHARGED_RETRY_CODES = new Set(['SLOT_TIMEOUT', 'BATCH_UNAVAILABLE', 'MODEL_CHECK_UNAVAILABLE', 'PLAN_UNAVAILABLE', 'PLAN_INVALID', 'SERVER_RESTARTING']);

/** A single-token get_run_status answers an invalid / foreign / expired token as NOT_FOUND with this text. */
function isRunTokenNotFound(code: string, message: string): boolean {
  return code === 'INVALID_RUN_TOKEN' || (code === 'NOT_FOUND' && /run ?token/i.test(message));
}

function detailString(payload: FailurePayload, key: string): string | undefined {
  const direct = str(payload[key]);
  if (direct) return direct;
  const details = payload.details && typeof payload.details === 'object' ? (payload.details as Record<string, unknown>) : {};
  return str(details[key]);
}

/** "google/nano-banana-2 (Nano Banana 2)" for each suggestion (objects or plain ids), at most 5. */
export function suggestionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value.slice(0, 5)) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
    else if (item && typeof item === 'object') {
      const id = str((item as Record<string, unknown>).id);
      const name = str((item as Record<string, unknown>).displayName);
      if (id) out.push(name && name !== id ? `${id} (${name})` : id);
    }
  }
  return out;
}

function modelHint(code: string, payload: FailurePayload): string {
  const first = Array.isArray(payload.suggestions) ? (payload.suggestions[0] as Record<string, unknown> | undefined) : undefined;
  const type = str(first && typeof first === 'object' ? first.mediaType : undefined) ?? str(payload.mediaType);
  const list = `aitopia models${type ? ` --type ${type}` : ''}`;
  if (code === 'MODEL_NOT_ALLOWED' || code === 'MODEL_NOT_IN_PLAYBOOK') {
    return `Use a suggested model, or set "allowAnyModel": true to run this exact model anyway (image/video/audio do that with --model). Nothing was spent.`;
  }
  return `List models with \`${list}\` and use an id it shows. Nothing was spent.`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

/** The low-level network code of a fetch failure, if it is one. */
export function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return 'FETCH_FAILED';
  return undefined;
}

const CERT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

/** MCP "request timed out" (the SDK gave up waiting for the answer). */
export const MCP_REQUEST_TIMEOUT = -32001;

/** Network failures before the request could reach the server (safe to try again). */
const PRE_CONNECTION_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  ...CERT_CODES,
]);

export const MAY_HAVE_REACHED_NOTE =
  'The request may have reached AITOPIA; check Open in AITOPIA (https://aitopia.ai/creations) or `aitopia status` before running it again.';

export interface ToCliErrorOptions {
  /**
   * The call may spend credits (generations, model / store-agent runs,
   * batches, paid edits). A failure after the request may have reached the
   * server is then "outcome unknown" (exit 5), never "try again".
   */
  paid?: boolean;
}

/** Converts anything thrown into a CliError. */
export function toCliError(error: unknown, serverUrl?: string, options: ToCliErrorOptions = {}): CliError {
  if (error instanceof CliError) return error;
  const host = serverUrl ? safeHost(serverUrl) : 'the AITOPIA server';
  const net = networkErrorCode(error);
  const status = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  const unknownOutcome = (detail: string) =>
    new CliError(`The connection to ${host} broke after the request was sent (${detail}).`, EXIT.PENDING, {
      code: 'OUTCOME_UNKNOWN',
      notes: [MAY_HAVE_REACHED_NOTE],
    });
  if (net) {
    if (options.paid && !PRE_CONNECTION_CODES.has(net)) return unknownOutcome(net);
    const hint = CERT_CODES.has(net)
      ? 'A proxy or firewall may be intercepting TLS. Set NODE_EXTRA_CA_CERTS to your company CA file.'
      : 'Check your internet connection or proxy settings.';
    return new CliError(`Cannot reach ${host} (${net}).`, EXIT.FAILED, { code: 'NETWORK', hint });
  }
  if (name === 'UnauthorizedError' || (typeof status === 'number' && status === 401)) {
    return new NotSignedInError('Your session has expired. Run `aitopia login`.', 'SESSION_EXPIRED');
  }
  if (typeof status === 'number' && status >= 500) {
    if (options.paid) return unknownOutcome(`HTTP ${status}`);
    return new CliError(`${host} answered HTTP ${status}. Try again in a moment.`, EXIT.FAILED, { code: 'SERVER_ERROR' });
  }
  if (typeof status === 'number' && status === MCP_REQUEST_TIMEOUT) {
    return new OutcomeUnknownError('The server did not answer in time. The request may still finish in AITOPIA.', {
      code: 'TIMEOUT',
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  // A dropped stream or any other unexplained failure (no HTTP status, no
  // JSON-RPC error code) after a paid request was sent.
  if (options.paid && typeof status !== 'number') return unknownOutcome(message || 'connection lost');
  return new CliError(message || 'Unexpected error.', EXIT.FAILED);
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
