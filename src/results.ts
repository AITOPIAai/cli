import { relative } from 'node:path';
import type { Context } from './context.js';
import { downloadAsset, resolveOutputTarget } from './download.js';
import { assetsOf, buyCreditsUrl, isFailed, openInAitopiaUrl, type ToolOutcome } from './envelope.js';
import { BUY_CREDITS_URL, CliError, EXIT, failureToError, formatNumber, RUN_LIMITED, runLimitNotes, runLimitOf, suggestionList, type RunLimit } from './errors.js';
import { isLoopbackHost } from './config.js';
import { addReadyResult, setActiveRun } from './interrupt.js';
import type { CallOptions, Session } from './mcp.js';
import { describeProgress, progressMessage, renderTable, type Output, type Spinner } from './output.js';
import { isRunning, waitForRun } from './poll.js';

export interface DeliverOptions {
  output?: string;
  force?: boolean;
  /** false with --no-download */
  download?: boolean;
}

/**
 * What the user sees while a call works: a spinner on a TTY whose label follows
 * the server's progress messages; on other terminals nothing until waiting
 * starts (then plain lines). With --verbose every server message is also
 * logged to stderr. stdout is never touched.
 */
export interface Activity {
  /** Pass to a tool call to receive live progress. */
  callOptions: CallOptions;
  /** The spinner, created on first use off a TTY. */
  spinner(): Spinner;
  stop(): void;
}

export function startActivity(ctx: Context, label: string): Activity {
  const { out } = ctx;
  let spinner: Spinner | undefined = out.stderrIsTTY ? out.spinner(label) : undefined;
  let last = '';
  let stopped = false;
  return {
    callOptions: {
      onProgress: (p) => {
        const message = progressMessage(p.message);
        if (!message || stopped) return;
        spinner?.setLabel(message);
        if (message !== last) out.debug(`progress: ${message}`);
        last = message;
      },
    },
    spinner: () => (spinner ??= out.spinner(label)),
    stop: () => {
      stopped = true;
      spinner?.stop();
    },
  };
}

/**
 * Waits for a running result (spinner on a TTY) and throws the mapped error on
 * failure. Returns the completed outcome.
 */
export async function settle(
  ctx: Context,
  session: Session,
  first: ToolOutcome,
  label: string,
  activity?: Activity,
): Promise<ToolOutcome> {
  let outcome = first;
  if (isRunning(first)) {
    const own = activity ?? startActivity(ctx, label);
    const spinner = own.spinner();
    try {
      outcome = await waitForRun(session.callTool, first, {
        onStart: (runToken) => {
          setActiveRun(runToken);
          ctx.out.debug(`run token: ${runToken}`);
        },
        onProgress: (p) => {
          spinner.update(describeProgress(p, { eta: !ctx.out.stderrIsTTY }));
          spinner.setEta(p.etaSeconds);
        },
        callOptions: own.callOptions,
        onNote: (note) => ctx.out.debug(`server: ${note}`),
      });
    } finally {
      own.stop();
      setActiveRun(undefined);
    }
  }
  activity?.stop();
  if (isFailed(outcome)) {
    throw failureToError(outcome.payload, {
      buyCreditsUrl: buyCreditsUrl(outcome),
      openInAitopia: openInAitopiaUrl(outcome),
    });
  }
  return outcome;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A balance's run limit (credits, whoami): a warning with the server's message verbatim, then when to try again / how to lift it. */
export function warnRunLimit(out: Output, limit: RunLimit, buyCreditsUrl?: string): void {
  out.warn(limit.message);
  for (const note of runLimitNotes(limit, { buyCreditsUrl })) out.note(note);
}

/** A dry run while runs are limited: "Not available: <server message>" instead of "Affordable". */
export function printRunLimitUnavailable(out: Output, limit: RunLimit, buyCreditsUrl?: string): void {
  out.line(`Not available: ${out.out.red(limit.message)}`);
  for (const note of runLimitNotes(limit, { buyCreditsUrl })) out.line(note);
}

/** A dryRun answer: {status:"estimate"} (single tools) or {status:"dry_run"} (generate_batch). */
export function isEstimate(outcome: ToolOutcome): boolean {
  return !outcome.isError && (outcome.payload.status === 'estimate' || outcome.payload.status === 'dry_run');
}

export function creditsText(value: unknown): string {
  if (typeof value === 'string' && value.toLowerCase() === 'unlimited') return 'unlimited';
  const n = num(value);
  return n === undefined ? 'unknown' : `${formatNumber(n)} credit${n === 1 ? '' : 's'}`;
}

/**
 * Prints a single tool's dryRun answer. Exit code stays 0 also when the
 * balance does not cover it (the price check itself worked); that case is said
 * plainly and `affordable: false` is in --json.
 */
export function deliverEstimate(ctx: Context, outcome: ToolOutcome, extra: { balance?: number | 'unlimited'; runLimit?: RunLimit } = {}): void {
  const { out } = ctx;
  if (isFailed(outcome)) {
    throw failureToError(outcome.payload, { buyCreditsUrl: buyCreditsUrl(outcome) });
  }
  if (!outcome.isError && outcome.payload.status === 'dry_run') {
    deliverBatchEstimate(ctx, outcome.payload, extra.balance, extra.runLimit);
    return;
  }
  if (!isEstimate(outcome)) {
    // Should not happen: the dry-run flag is only sent to tools that support it.
    out.warn('The server did not return a price estimate. The result is below.');
    if (out.jsonMode) out.json(outcome.payload);
    else out.line(JSON.stringify(outcome.payload, null, 2));
    return;
  }
  const p = outcome.payload;
  if (out.jsonMode) {
    out.json(p);
    return;
  }
  const balance = p.balance && typeof p.balance === 'object' ? (p.balance as Record<string, unknown>).creditsForGeneration : undefined;
  out.line(`${out.out.bold('Estimate:')} ${creditsText(p.credits)}`);
  if (typeof p.basis === 'string' && p.basis) out.line(`Basis: ${p.basis}`);
  if (p.breakdown && typeof p.breakdown === 'object') {
    const parts = Object.entries(p.breakdown as Record<string, unknown>)
      .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
      .map(([k, v]) => `${k} ${String(v)}`);
    if (parts.length > 0) out.line(out.out.dim(`Breakdown: ${parts.join(', ')}`));
  }
  out.line(`Balance: ${balance === null || balance === undefined ? 'unknown' : `${creditsText(balance)} available`}`);
  const runLimit = runLimitOf(p) ?? extra.runLimit;
  if (runLimit) printRunLimitUnavailable(out, runLimit, buyCreditsUrl(outcome));
  else if (p.affordable === true) out.line(`Affordable: ${out.out.green('yes')}`);
  else if (p.affordable === false) {
    out.line(`Affordable: ${out.out.red('no, not enough credits')}`);
    out.line(`Buy credits: ${typeof p.buyCreditsUrl === 'string' && p.buyCreditsUrl ? p.buyCreditsUrl : BUY_CREDITS_URL}`);
  } else if (typeof p.balanceNote === 'string') out.note(p.balanceNote);
  out.line(out.out.dim('Nothing was submitted or charged.'));
}

/**
 * Prints generate_batch's dryRun: per item, the total and (when known) the
 * balance. Exit 1 when an item would be refused (its run would fail), else 0
 * (also when the balance is short: that is said plainly).
 */
export function deliverBatchEstimate(ctx: Context, payload: Record<string, unknown>, balance?: number | 'unlimited', balanceRunLimit?: RunLimit): void {
  const { out } = ctx;
  const runLimit = runLimitOf(payload) ?? balanceRunLimit;
  const items = (Array.isArray(payload.items) ? payload.items : []).filter(
    (i): i is Record<string, unknown> => Boolean(i) && typeof i === 'object',
  );
  const total = num(payload.totalCredits) ?? 0;
  const affordable = balance === undefined ? null : balance === 'unlimited' || balance >= total;
  const refused = items.filter((i) => typeof i.code === 'string');
  const body = {
    ...payload,
    ...(balance !== undefined ? { balance: { creditsForGeneration: balance }, affordable } : {}),
    ...(runLimit && !payload.runLimit ? { runLimit } : {}),
  };
  if (!out.jsonMode) {
    const rows: string[][] = [['ITEM', 'KIND', 'MODEL', 'CREDITS', 'BASIS']];
    for (const item of items) {
      const index = num(item.index);
      const itemLimit = runLimitOf(item);
      const note = itemLimit
        ? `${itemLimit.code}: see below` // shown whole below the table (it has line breaks)
        : typeof item.code === 'string'
          ? `${item.code}: ${typeof item.error === 'string' ? item.error : 'would be refused'}`
          : typeof item.basis === 'string'
            ? item.basis
            : '';
      rows.push([
        index === undefined ? '?' : String(index + 1),
        typeof item.kind === 'string' ? item.kind : '',
        typeof item.modelId === 'string' ? item.modelId : '',
        num(item.credits) === undefined ? '-' : formatNumber(num(item.credits) as number),
        note,
      ]);
    }
    for (const row of renderTable(rows, [4, 5, 40, 8])) out.line(row);
    for (const item of refused) {
      const lines = suggestionList(item.suggestions);
      if (lines.length > 0) out.line(`  item ${(num(item.index) ?? 0) + 1}: did you mean: ${lines.join(', ')}`);
    }
    const priced = items.filter((i) => num(i.credits) !== undefined).length;
    const coverage = payload.complete === false ? ` (${priced} of ${items.length} items priced)` : '';
    out.line(`${out.out.bold('Total:')} ${creditsText(total)}${coverage}`);
    if (balance !== undefined) out.line(`Balance: ${creditsText(balance)} available`);
    const shownLimit = runLimit ?? refused.map((i) => runLimitOf(i)).find((l) => l !== undefined);
    if (shownLimit) printRunLimitUnavailable(out, shownLimit);
    else if (affordable === false) {
      out.line(out.out.red('Not enough credits for this batch.'));
      out.line(`Buy credits: ${BUY_CREDITS_URL}`);
    }
    out.line(out.out.dim('Nothing was submitted or charged.'));
  }
  if (refused.length > 0) {
    const allLimited = refused.every((i) => runLimitOf(i) !== undefined);
    const codes = new Set(refused.map((i) => (runLimitOf(i) ? RUN_LIMITED : String(i.code))));
    throw new CliError(`${refused.length} of ${items.length} items would be refused.`, allLimited ? EXIT.RUN_LIMITED : EXIT.FAILED, {
      code: codes.size === 1 ? [...codes][0] : 'ITEMS_REFUSED',
      hint: 'Fix those items (see above) before running the batch. Nothing was spent.',
      data: { ...body, status: 'dry_run' },
    });
  }
  if (out.jsonMode) out.json(body);
}

function display(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}

/** Whether plain http to 127.0.0.1 is acceptable (only when the server itself is local). */
export function allowHttpLoopback(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Downloads the result's files (unless --no-download), prints them and the
 * "Open in AITOPIA" link, or in --json mode prints the payload plus `files`.
 * `showPayload` prints the payload as JSON when there are no files (for `run`).
 * If a download fails the result is still shown (it was already paid for).
 */
export async function deliver(
  ctx: Context,
  outcome: ToolOutcome,
  options: DeliverOptions,
  extra: { showPayload?: boolean; expectFiles?: boolean; prompt?: string } = {},
): Promise<string[]> {
  const { out } = ctx;
  const assets = assetsOf(outcome);
  const open = openInAitopiaUrl(outcome);
  const files: string[] = [];

  const failures = outcome.payload.failures;
  if (Array.isArray(failures) && failures.length > 0) {
    out.warn(`${failures.length} of the requested items failed.`);
    for (const f of failures) {
      const message =
        f && typeof f === 'object' && typeof (f as { error?: unknown }).error === 'string' ? (f as { error: string }).error : JSON.stringify(f);
      out.note(`  ${message}`);
    }
  }

  // Paid for and ready: Ctrl+C from here on still says where they are.
  const ready = assets.map((asset) => addReadyResult({ assetUrl: asset.url, name: asset.name, openInAitopia: open }));
  if (options.download !== false && assets.length > 0) {
    const target = resolveOutputTarget(options.output);
    try {
      for (const [index, asset] of assets.entries()) {
        out.debug(`downloading ${asset.url}`);
        const path = await downloadAsset(asset.url, {
          target,
          index,
          total: assets.length,
          assetName: asset.name,
          fallbackName: extra.prompt,
          force: options.force === true,
          allowHttpLoopback: allowHttpLoopback(ctx.serverUrl),
        });
        files.push(path);
        const entry = ready[index];
        if (entry) entry.file = path;
      }
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (!out.jsonMode) {
        for (const file of files) out.line(`${out.out.green('Saved')} ${display(file)}`);
        for (const asset of assets.slice(files.length)) out.line(asset.url);
        if (open) out.line(`${out.out.dim('Open in AITOPIA:')} ${open}`);
      }
      throw new CliError(`Could not download the result: ${cause}`, EXIT.FAILED, {
        code: 'DOWNLOAD_FAILED',
        hint: 'The result is ready; do not generate it again. Download it from the URL above.',
        data: { ...outcome.payload, files, assetUrls: assets.map((a) => a.url) },
      });
    }
  }

  const noFiles = assets.length === 0 && extra.expectFiles === true;
  if (noFiles) out.warn('The run finished but returned no file. The full result is below.');

  if (out.jsonMode) {
    out.json({ ...outcome.payload, files, ...(assets.length > 0 ? { assetUrls: assets.map((a) => a.url) } : {}) });
    return files;
  }

  if (files.length > 0) {
    for (const file of files) out.line(`${out.out.green('Saved')} ${display(file)}`);
  } else if (assets.length > 0) {
    for (const asset of assets) out.line(asset.url);
  } else if (extra.showPayload || noFiles) {
    out.line(JSON.stringify(outcome.payload, null, 2));
  } else if (typeof outcome.payload.text === 'string') {
    out.line(outcome.payload.text);
  }
  if (open) out.line(`${out.out.dim('Open in AITOPIA:')} ${open}`);
  return files;
}
