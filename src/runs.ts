import { statSync } from 'node:fs';
import { relative } from 'node:path';
import type { Context } from './context.js';
import { downloadAsset, resolveOutputTarget, type OutputTarget } from './download.js';
import { assetsOf, openInAitopiaUrl } from './envelope.js';
import {
  BUY_CREDITS_URL,
  CliError,
  EXIT,
  NOT_CHARGED_RETRY_CODES,
  UsageError,
  failureToError,
  statusNotes,
} from './errors.js';
import { addReadyResult, setActiveRun } from './interrupt.js';
import type { Session } from './mcp.js';
import { describeProgress } from './output.js';
import { progressOf, waitForRuns } from './poll.js';
import { allowHttpLoopback, startActivity, type DeliverOptions } from './results.js';

/** One run of a batch, or one token of `aitopia status a b c`. */
export interface RunItem {
  /** 0-based position (the server's `index`). */
  index: number;
  /** "item 1", "run 2" */
  label: string;
  kind?: string;
  modelId?: string | null;
  prompt?: string;
  /** Name chosen by the user (wins over the server's name for the file). */
  assetName?: string;
  runToken?: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  /** Why the outcome is unknown (no answer from AITOPIA, interrupted, still running when waiting stopped). */
  unknownReason?: 'interrupted' | 'still_running' | 'no_answer';
  payload: Record<string, unknown>;
  files: string[];
  assetUrls: string[];
  failure?: CliError;
  downloadError?: string;
}

/** -o for several results: always a directory (created when missing). */
export function directoryTarget(output: string | undefined): OutputTarget {
  const target = resolveOutputTarget(output);
  if (target.kind === 'dir') return target;
  let isFile = false;
  try {
    isFile = statSync(target.path).isFile();
  } catch {
    // does not exist yet: created on the first download
  }
  if (isFile) throw new UsageError(`-o must be a directory here; ${output} is a file.`);
  return { kind: 'dir', path: target.path };
}

function display(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}

function describe(item: RunItem): string {
  const bits = [item.kind, item.modelId].filter((b): b is string => typeof b === 'string' && b.length > 0);
  return bits.length > 0 ? `${item.label} (${bits.join(', ')})` : item.label;
}

export interface ItemDelivery extends DeliverOptions {
  target: OutputTarget;
  /** Items in the whole set (file names get an index suffix when > 1). */
  total: number;
}

/** Records how an item ended; downloads its file at once and prints one line (human mode). */
export async function settleItem(
  ctx: Context,
  item: RunItem,
  payload: Record<string, unknown>,
  isError: boolean,
  delivery: ItemDelivery,
): Promise<void> {
  const { out } = ctx;
  item.payload = payload;
  if (typeof payload.runToken === 'string') item.runToken = payload.runToken;
  if (typeof payload.modelId === 'string' && !item.modelId) item.modelId = payload.modelId;
  const outcome = { payload, isError, links: [] };
  if (isError || payload.status === 'failed') {
    item.status = 'failed';
    item.failure = failureToError(payload, { openInAitopia: openInAitopiaUrl(outcome) });
    if (!out.jsonMode) {
      out.note(out.err.red(`Failed: ${describe(item)}: ${item.failure.message}`));
      for (const line of item.failure.notes) out.note(`  ${line}`);
      if (item.failure.hint) out.note(`  ${item.failure.hint}`);
    }
    return;
  }
  item.status = 'completed';
  const assets = assetsOf(outcome);
  item.assetUrls = assets.map((a) => a.url);
  // Ready (and paid for): Ctrl+C before or during the download still lists it.
  const open = openInAitopiaUrl(outcome);
  const ready = assets.map((a) =>
    addReadyResult({ assetUrl: a.url, label: item.label, ...(a.name ? { name: a.name } : {}), ...(open ? { openInAitopia: open } : {}) }),
  );
  if (delivery.download === false || assets.length === 0) {
    if (!out.jsonMode) {
      if (assets.length === 0) out.warn(`${describe(item)} finished but returned no file.`);
      for (const url of item.assetUrls) out.line(`${item.label}: ${url}`);
    }
    return;
  }
  try {
    for (const [sub, asset] of assets.entries()) {
      out.debug(`downloading ${asset.url}`);
      const path = await downloadAsset(asset.url, {
        target: delivery.target,
        index: item.index,
        total: delivery.total,
        // Several files of one item: base-N-1, base-N-2 (never the same name).
        sub,
        subTotal: assets.length,
        // The user's name, else the prompt; the server's own name only without a prompt.
        assetName: item.assetName ?? (item.prompt ? undefined : asset.name),
        fallbackName: item.prompt,
        force: delivery.force === true,
        allowHttpLoopback: allowHttpLoopback(ctx.serverUrl),
      });
      item.files.push(path);
      const entry = ready[sub];
      if (entry) entry.file = path;
      if (!out.jsonMode) out.line(`${out.out.green('Saved')} ${display(path)}`);
    }
  } catch (error) {
    item.downloadError = error instanceof Error ? error.message : String(error);
    if (!out.jsonMode) {
      out.note(out.err.red(`Could not download ${item.label}: ${item.downloadError}`));
      for (const url of item.assetUrls.slice(item.files.length)) out.line(`${item.label}: ${url}`);
    }
  }
}

/**
 * Waits for the items still running (only get_run_status with their
 * runTokens; nothing is ever submitted again). `untilDone: false` checks once.
 * Finished files are downloaded as soon as each run ends.
 */
export async function followItems(
  ctx: Context,
  session: Session,
  items: RunItem[],
  delivery: ItemDelivery,
  options: { untilDone: boolean; label: string },
): Promise<void> {
  for (const item of items) if (item.status === 'running' && !item.runToken) item.status = 'unknown';
  const running = () => items.filter((i) => i.status === 'running' && i.runToken);
  if (running().length === 0) return;
  const byToken = new Map(running().map((i) => [i.runToken as string, i]));
  const waitingLabel = () => `Waiting for ${running().length} of ${delivery.total}`;
  const activity = startActivity(ctx, options.untilDone ? waitingLabel() : options.label);
  const spinner = options.untilDone ? activity.spinner() : undefined;
  setActiveRun([...byToken.keys()]);
  try {
    const ends = await waitForRuns(session.callTool, [...byToken.keys()], {
      untilDone: options.untilDone,
      callOptions: activity.callOptions,
      onEnd: async (token, end) => {
        const item = byToken.get(token);
        if (item) await settleItem(ctx, item, end.payload, end.isError, delivery);
        setActiveRun(running().map((i) => i.runToken as string));
        // The number still going, right away (not only after the round).
        spinner?.setLabel(waitingLabel());
      },
      onNote: (note) => ctx.out.debug(`server: ${note}`),
      onRound: (still) => {
        if (!spinner) return;
        spinner.setLabel(`Waiting for ${still.length} of ${delivery.total}`);
        const etas = still.map((s) => progressOf(s.runToken, { payload: s.payload, isError: false, links: [] }).etaSeconds);
        const known = etas.filter((e): e is number => typeof e === 'number' && e > 0);
        spinner.setEta(known.length > 0 ? Math.max(...known) : undefined);
        if (still.length === 1 && still[0]) {
          spinner.update(describeProgress(progressOf(still[0].runToken, { payload: still[0].payload, isError: false, links: [] }), { eta: false }));
        }
      },
    });
    for (const [token, end] of ends) {
      const item = byToken.get(token);
      if (!item || end.state !== 'unknown') continue;
      item.payload = end.payload;
      // One check without waiting: a run seen running is a state; no answer at all is unknown (exit 5).
      const stillRunning = !options.untilDone && end.reason === 'still_running';
      item.status = stillRunning ? 'running' : 'unknown';
      if (!stillRunning) item.unknownReason = end.reason;
      if (end.reason === 'no_answer' && !ctx.out.jsonMode) ctx.out.note(`${item.label}: AITOPIA did not answer for this run.`);
    }
  } finally {
    activity.stop();
    setActiveRun(undefined);
  }
}

function itemJson(item: RunItem): Record<string, unknown> {
  const p = item.payload;
  return {
    index: item.index,
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.modelId !== undefined ? { modelId: item.modelId } : {}),
    ...(item.prompt ? { prompt: item.prompt } : {}),
    status: item.status,
    ...(item.runToken ? { runToken: item.runToken } : {}),
    ...(item.assetUrls.length > 0 ? { assetUrl: item.assetUrls[0], assetUrls: item.assetUrls } : {}),
    ...(item.files.length > 0 ? { files: item.files } : {}),
    ...(typeof p.assetName === 'string' ? { assetName: p.assetName } : {}),
    ...(typeof p.creationUrl === 'string' ? { creationUrl: p.creationUrl } : {}),
    ...(item.failure
      ? {
          code: item.failure.code,
          error: item.failure.message,
          ...(typeof p.retryable === 'boolean' ? { retryable: p.retryable } : {}),
          ...(Array.isArray(p.suggestions) ? { suggestions: p.suggestions } : {}),
          ...(item.failure.hint ? { hint: item.failure.hint } : {}),
        }
      : {}),
    ...(item.downloadError ? { downloadError: item.downloadError } : {}),
    ...(item.status === 'running' || item.status === 'unknown'
      ? {
          ...(typeof p.progress === 'number' ? { progress: p.progress } : {}),
          ...(typeof p.etaSeconds === 'number' ? { etaSeconds: p.etaSeconds } : {}),
        }
      : {}),
  };
}

function overall(items: RunItem[]): 'completed' | 'partial' | 'failed' | 'running' {
  if (items.some((i) => i.status === 'running' || i.status === 'unknown')) return 'running';
  if (items.every((i) => i.status === 'completed')) return 'completed';
  if (items.every((i) => i.status === 'failed')) return 'failed';
  return 'partial';
}

/**
 * Prints the summary and sets the exit code:
 *   0 every item finished (and was saved),
 *   1 some failed or could not be downloaded (the rest are still saved),
 *   4 every failure was "not enough credits",
 *   5 some outcome is unknown (still running when waiting stopped, or interrupted).
 * `runningIsOk` (status without --wait): items still running are reported, exit 0.
 */
export function finishItems(
  ctx: Context,
  items: RunItem[],
  extra: { noun: string; runningIsOk?: boolean; openInAitopia?: string } = { noun: 'item' },
): void {
  const { out } = ctx;
  const total = items.length;
  const plural = (n: number) => `${n} ${extra.noun}${n === 1 ? '' : 's'}`;
  const completed = items.filter((i) => i.status === 'completed');
  const failed = items.filter((i) => i.status === 'failed');
  const running = items.filter((i) => i.status === 'running');
  const unknown = items.filter((i) => i.status === 'unknown');
  const downloadFailed = items.filter((i) => i.downloadError);
  const pendingTokens = [...running, ...unknown].map((i) => i.runToken).filter((t): t is string => Boolean(t));
  const files = items.flatMap((i) => i.files);
  const summary: Record<string, unknown> = {
    status: overall(items),
    total,
    completed: completed.length,
    failed: failed.length,
    running: running.length + unknown.length,
    items: items.map(itemJson),
    files,
    ...(pendingTokens.length > 0 ? { runTokens: pendingTokens } : {}),
    ...(extra.openInAitopia ? { openInAitopia: extra.openInAitopia } : {}),
  };

  const parts = [`${completed.length} of ${plural(total)} finished`];
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  if (running.length + unknown.length > 0) parts.push(`${running.length + unknown.length} still running`);
  const headline = `${parts.join(', ')}.`;

  if (unknown.length > 0 || (running.length > 0 && !extra.runningIsOk)) {
    throw new CliError(`${headline} The rest may still finish in AITOPIA.`, EXIT.PENDING, {
      code: 'OUTCOME_UNKNOWN',
      notes: pendingTokens.length > 0 ? statusNotes(pendingTokens) : ['Check AITOPIA for the results before running them again.'],
      data: summary,
    });
  }
  if (failed.length > 0) {
    const codes = new Set(failed.map((i) => i.failure?.code ?? 'FAILED'));
    const onlyCredits = codes.size === 1 && codes.has('INSUFFICIENT_CREDITS');
    const notCharged = [...codes].every((c) => NOT_CHARGED_RETRY_CODES.has(c));
    const code = codes.size === 1 ? [...codes][0] ?? 'FAILED' : 'PARTIAL';
    const notes: string[] = [];
    if (onlyCredits) notes.push(`Buy credits: ${BUY_CREDITS_URL}`);
    if (extra.openInAitopia) notes.push(`Open in AITOPIA: ${extra.openInAitopia}`);
    throw new CliError(headline, onlyCredits ? EXIT.CREDITS : EXIT.FAILED, {
      code,
      hint: notCharged ? 'Nothing was submitted or charged for the failed items; it is safe to run them again.' : undefined,
      notes,
      data: summary,
    });
  }
  if (downloadFailed.length > 0) {
    throw new CliError(`${headline} ${downloadFailed.length} could not be downloaded.`, EXIT.FAILED, {
      code: 'DOWNLOAD_FAILED',
      hint: 'The results are ready; do not generate them again. Download them from the URLs above.',
      data: summary,
    });
  }
  if (out.jsonMode) {
    out.json(summary);
    return;
  }
  out.line(headline);
  if (running.length > 0 && extra.runningIsOk && pendingTokens.length > 0) {
    out.line(`Wait for ${running.length === 1 ? 'it' : 'them'} with: aitopia status ${pendingTokens.join(' ')} --wait`);
  }
  if (extra.openInAitopia) out.line(`${out.out.dim('Open in AITOPIA:')} ${extra.openInAitopia}`);
}
