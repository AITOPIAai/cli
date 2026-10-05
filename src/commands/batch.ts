import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { withSession, type Context } from '../context.js';
import { failureToError, runLimitOf, UsageError, type RunLimit } from '../errors.js';
import { buyCreditsUrl, isFailed } from '../envelope.js';
import { inFlight, setActiveRun } from '../interrupt.js';
import type { Session } from '../mcp.js';
import { MAX_RUN_TOKENS } from '../poll.js';
import { allowHttpLoopback, deliverEstimate, startActivity, type DeliverOptions } from '../results.js';
import { directoryTarget, finishItems, followItems, settleItem, type ItemDelivery, type RunItem } from '../runs.js';
import { checkScopeOptions, resolveScope, type ScopeOptions } from '../resolve.js';
import { assertLocalFile, uploadSource } from '../upload.js';
import { spendableCredits } from './credits.js';

export const BATCH_KINDS = ['image', 'audio', 'video'] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

export interface BatchItem {
  kind: BatchKind;
  prompt: string;
  modelId: string;
  input?: Record<string, unknown>;
  assetName?: string;
  allowAnyModel?: boolean;
}

export interface BatchOptions extends DeliverOptions, ScopeOptions {
  dryRun?: boolean;
  /** false with --no-wait: return after the first answer. */
  wait?: boolean;
}

const ITEM_KEYS = new Set(['kind', 'prompt', 'modelId', 'input', 'assetName', 'allowAnyModel']);
/** Seconds generate_batch waits for the items before it answers (its maximum). */
export const BATCH_WAIT_SEC = 20;
/** Stand-in for a local file on --dry-run (prices do not depend on it; nothing is uploaded). */
export const DRY_RUN_FILE_URL = 'https://example.invalid/local-file';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a batch file's content (an array of items, or {items: [...]}) before anything is sent. */
export function parseBatch(raw: unknown): BatchItem[] {
  const list = Array.isArray(raw) ? raw : isObject(raw) ? raw.items : undefined;
  if (!Array.isArray(list)) throw new UsageError('A batch file holds a JSON array of items, or {"items": [...]}.');
  if (list.length < 1 || list.length > MAX_RUN_TOKENS) {
    throw new UsageError(`A batch holds 1 to ${MAX_RUN_TOKENS} items; this one has ${list.length}.`);
  }
  return list.map((entry, i) => {
    const where = `Item ${i + 1}`;
    if (!isObject(entry)) throw new UsageError(`${where} must be an object.`);
    const unknown = Object.keys(entry).filter((k) => !ITEM_KEYS.has(k));
    if (unknown.length > 0) {
      throw new UsageError(`${where} has unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}.`, `Allowed: ${[...ITEM_KEYS].join(', ')}.`);
    }
    const { kind, prompt, modelId, input, assetName, allowAnyModel } = entry;
    if (typeof kind !== 'string' || !(BATCH_KINDS as readonly string[]).includes(kind)) {
      throw new UsageError(`${where}: kind must be image, audio or video.`);
    }
    if (typeof prompt !== 'string' || !prompt.trim()) throw new UsageError(`${where}: prompt is required.`);
    if (typeof modelId !== 'string' || !modelId.trim()) {
      throw new UsageError(`${where}: modelId is required.`, `Pick one with \`aitopia models --type ${kind}\`.`);
    }
    if (input !== undefined && !isObject(input)) throw new UsageError(`${where}: input must be an object.`);
    if (assetName !== undefined && typeof assetName !== 'string') throw new UsageError(`${where}: assetName must be a string.`);
    if (allowAnyModel !== undefined && typeof allowAnyModel !== 'boolean') throw new UsageError(`${where}: allowAnyModel must be true or false.`);
    return {
      kind: kind as BatchKind,
      prompt: prompt.trim(),
      modelId: modelId.trim(),
      ...(input !== undefined ? { input: { ...input } } : {}),
      ...(typeof assetName === 'string' && assetName.trim() ? { assetName: assetName.trim() } : {}),
      ...(allowAnyModel === true ? { allowAnyModel: true } : {}),
    };
  });
}

/** Input fields that take a file URL (image_url, start_image_url, image_urls, imageUrl, audio, mask, ...). */
const FILE_FIELD = /(?:url|urls|image|images|video|videos|audio|mask|file|files)$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A value in a file field that names a local file (not a URL): has a path separator or a file extension. */
export function looksLikeLocalPath(value: string): boolean {
  if (!value.trim() || HAS_SCHEME.test(value)) return false;
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{2,5}$/.test(value);
}

/** Every local path in the items' file fields: [item index, field, position in an array or -1, path]. */
export function localFileRefs(items: BatchItem[]): Array<{ item: number; field: string; at: number; path: string }> {
  const refs: Array<{ item: number; field: string; at: number; path: string }> = [];
  items.forEach((item, i) => {
    for (const [field, value] of Object.entries(item.input ?? {})) {
      if (!FILE_FIELD.test(field)) continue;
      if (typeof value === 'string' && looksLikeLocalPath(value)) refs.push({ item: i, field, at: -1, path: value });
      if (Array.isArray(value)) {
        value.forEach((v, at) => {
          if (typeof v === 'string' && looksLikeLocalPath(v)) refs.push({ item: i, field, at, path: v });
        });
      }
    }
  });
  return refs;
}

/** Checks every local file the items name (exit 2 naming the item and field). */
export function checkLocalFiles(items: BatchItem[], baseDir: string): ReturnType<typeof localFileRefs> {
  const refs = localFileRefs(items);
  for (const ref of refs) {
    try {
      assertLocalFile(resolve(baseDir, ref.path));
    } catch (error) {
      if (error instanceof UsageError) throw new UsageError(`Item ${ref.item + 1}, ${ref.field}: ${error.message}`);
      throw error;
    }
  }
  return refs;
}

/**
 * Replaces local paths in file fields with hosted URLs: each file is uploaded
 * once (like `video --image`). On --dry-run files are only checked, not
 * uploaded. Relative paths are read from the batch file's folder.
 */
export async function uploadLocalFiles(
  ctx: Context,
  session: Session,
  items: BatchItem[],
  baseDir: string,
  dryRun: boolean,
): Promise<BatchItem[]> {
  const refs = checkLocalFiles(items, baseDir);
  if (refs.length === 0) return items;
  const urls = new Map<string, string>();
  for (const ref of refs) {
    const full = resolve(baseDir, ref.path);
    if (urls.has(full)) continue;
    if (dryRun) {
      urls.set(full, DRY_RUN_FILE_URL);
      continue;
    }
    if (!ctx.out.jsonMode) ctx.out.note(`Uploading ${ref.path}...`);
    const result = await uploadSource(session.callTool, full, { allowHttpLoopback: allowHttpLoopback(ctx.serverUrl) });
    urls.set(full, result.assetUrl);
  }
  const out = items.map((item) => ({ ...item, ...(item.input ? { input: { ...item.input } } : {}) }));
  for (const ref of refs) {
    const input = out[ref.item]?.input;
    if (!input) continue;
    const url = urls.get(resolve(baseDir, ref.path)) as string;
    if (ref.at < 0) input[ref.field] = url;
    else input[ref.field] = (input[ref.field] as unknown[]).map((v, at) => (at === ref.at ? url : v));
  }
  return out;
}

function readBatchFile(file: string): { raw: unknown; baseDir: string } {
  let text: string;
  try {
    text = readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (error) {
    throw new UsageError(`Cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  try {
    return { raw: JSON.parse(text) as unknown, baseDir: file === '-' ? process.cwd() : dirname(resolve(file)) };
  } catch (error) {
    throw new UsageError(`${file === '-' ? 'stdin' : file} is not valid JSON: ${(error as Error).message}`);
  }
}

/** The spendable balance and any run limit it carries (both unknown when the balance cannot be read). */
async function balanceOf(session: Session): Promise<{ balance?: number | 'unlimited'; runLimit?: RunLimit }> {
  try {
    const outcome = await session.callTool('get_credit_balance', {});
    if (isFailed(outcome)) return { runLimit: runLimitOf(outcome.payload) };
    return { balance: spendableCredits(outcome.payload), runLimit: runLimitOf(outcome.payload) };
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export async function batchCommand(ctx: Context, file: string, options: BatchOptions): Promise<void> {
  const { raw, baseDir } = readBatchFile(file);
  const parsed = parseBatch(raw);
  const untilDone = options.wait !== false;
  const target = directoryTarget(options.output);
  checkLocalFiles(parsed, baseDir);
  checkScopeOptions(options);

  await withSession(ctx, async (session) => {
    // Before the uploads and the paid call: a project that does not exist stops here.
    const scope = await resolveScope(ctx, session, options);
    const items = await uploadLocalFiles(ctx, session, parsed, baseDir, options.dryRun === true);
    const args: Record<string, unknown> = { items, wait: untilDone ? BATCH_WAIT_SEC : 0, ...scope };

    if (options.dryRun) {
      args.dryRun = true;
      const outcome = await session.callTool('generate_batch', args);
      if (outcome.isError) throw failureToError(outcome.payload, { buyCreditsUrl: buyCreditsUrl(outcome) });
      deliverEstimate(ctx, outcome, await balanceOf(session));
      return;
    }

    const label = `Generating ${items.length} item${items.length === 1 ? '' : 's'}`;
    const activity = startActivity(ctx, label);
    let first;
    try {
      first = await inFlight(() => session.callTool('generate_batch', args, { ...activity.callOptions, paid: true }));
    } finally {
      activity.stop();
    }
    // Refused as a whole (BATCH_UNAVAILABLE, RATE_LIMIT, INVALID_INPUT): nothing was submitted.
    // (Every item failing is an ordinary answer with status "failed", not an error.)
    if (first.isError) throw failureToError(first.payload, { buyCreditsUrl: buyCreditsUrl(first) });

    const answered = Array.isArray(first.payload.items) ? (first.payload.items as unknown[]) : [];
    const runItems: RunItem[] = items.map((item, index) => ({
      index,
      label: `item ${index + 1}`,
      kind: item.kind,
      modelId: item.modelId,
      prompt: item.prompt,
      assetName: item.assetName,
      status: 'unknown',
      payload: {},
      files: [],
      assetUrls: [],
    }));
    const delivery: ItemDelivery = { ...options, target, total: items.length };
    // Ctrl+C while the finished files download still names the runs going on.
    setActiveRun(answered.flatMap((e) => (e && typeof e === 'object' && typeof (e as { runToken?: unknown }).runToken === 'string' ? [(e as { runToken: string }).runToken] : [])));
    for (const entry of answered) {
      if (!entry || typeof entry !== 'object') continue;
      const payload = entry as Record<string, unknown>;
      const index = typeof payload.index === 'number' ? payload.index : -1;
      const item = runItems[index];
      if (!item) continue;
      item.runToken = str(payload.runToken);
      if (payload.status === 'running') {
        item.status = 'running';
        item.payload = payload;
      } else {
        await settleItem(ctx, item, payload, payload.status === 'failed', delivery);
      }
    }
    for (const item of runItems) if (item.status === 'running' && !item.runToken) item.status = 'unknown';
    setActiveRun(runItems.filter((i) => i.status === 'running').map((i) => i.runToken as string));
    // --no-wait: the batch call already answered once; report and stop (exit 5 while items run).
    if (untilDone) await followItems(ctx, session, runItems, delivery, { untilDone, label: 'Waiting for the items' });
    finishItems(ctx, runItems, { noun: 'item', openInAitopia: str(first.payload.openInAitopia) });
  });
}
