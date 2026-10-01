import { basename, extname, relative } from 'node:path';
import { joinWords } from '../args.js';
import { withSession, type Context } from '../context.js';
import { downloadAsset, resolveOutputTarget, slugify, type OutputTarget } from '../download.js';
import { assetsOf, buyCreditsUrl, isFailed, openInAitopiaUrl, type ToolOutcome } from '../envelope.js';
import { CliError, EXIT, UsageError, exitCodeFor, failureToError } from '../errors.js';
import { addReadyResult, setActiveRun } from '../interrupt.js';
import type { Session } from '../mcp.js';
import { describeProgress, progressMessage } from '../output.js';
import { isRunning, waitForRun } from '../poll.js';
import { allowHttpLoopback, creditsText, startActivity, type Activity, type DeliverOptions } from '../results.js';
import { assertLocalFile, contentTypeFor, isRemoteUrl, uploadSource } from '../upload.js';
import { paidCall } from './generate.js';
import { fileStamp, keepPlan, keptPlan, sourceKey } from '../edit-plans.js';

export interface EditOptions extends DeliverOptions {
  dryRun?: boolean;
  maxCredits?: number;
  keepSteps?: boolean;
  /** The planToken of an earlier --dry-run: runs exactly that plan. */
  plan?: string;
}

/** One step of an edit plan, as edit_media reports it. */
export interface PlanStep {
  index?: number;
  kind?: string;
  id?: string;
  displayName?: string;
  why?: string;
  status?: string;
  assetUrl?: string;
  credits?: number;
  basis?: string;
  /** The price is the model's listed price, not an exact quote. */
  creditsEstimated?: boolean;
  /** The file already met this step; it was skipped at 0 credits. */
  unchanged?: boolean;
  code?: string;
  error?: string;
}

export interface EditPlan {
  summary?: string;
  steps: PlanStep[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A field of the payload, or of `details` (failures carry tool facts there). */
function field(payload: Record<string, unknown>, key: string): unknown {
  if (payload[key] !== undefined) return payload[key];
  return isObject(payload.details) ? payload.details[key] : undefined;
}

/** The plan of an edit_media answer (top level, or under details on a failure). */
export function planOf(payload: Record<string, unknown>): EditPlan | undefined {
  const raw = field(payload, 'plan');
  if (!isObject(raw) || !Array.isArray(raw.steps)) return undefined;
  const steps = raw.steps.filter(isObject).map(
    (s): PlanStep => ({
      ...(num(s.index) !== undefined ? { index: num(s.index) } : {}),
      ...(str(s.kind) ? { kind: str(s.kind) } : {}),
      ...(str(s.id) ? { id: str(s.id) } : {}),
      ...(str(s.displayName) ? { displayName: str(s.displayName) } : {}),
      ...(str(s.why) ? { why: str(s.why) } : {}),
      ...(str(s.status) ? { status: str(s.status) } : {}),
      ...(str(s.assetUrl) ? { assetUrl: str(s.assetUrl) } : {}),
      ...(num(s.credits) !== undefined ? { credits: num(s.credits) } : {}),
      ...(str(s.basis) ? { basis: str(s.basis) } : {}),
      ...(s.creditsEstimated === true ? { creditsEstimated: true } : {}),
      ...(s.unchanged === true ? { unchanged: true } : {}),
      ...(str(s.code) ? { code: str(s.code) } : {}),
      ...(str(s.error) ? { error: str(s.error) } : {}),
    }),
  );
  return { ...(str(raw.summary) ? { summary: str(raw.summary) } : {}), steps };
}

function stepName(step: PlanStep): string {
  return step.displayName ?? step.id ?? 'step';
}

const STATUS_WORDS: Record<string, string> = { completed: 'done', failed: 'failed', running: 'running', skipped: 'skipped' };

/** The plan as numbered lines: "1. Topaz Image Upscale (model) · 4 credits", then why (and the price basis). */
export function planLines(plan: EditPlan, options: { statuses?: boolean; basis?: boolean } = {}): string[] {
  const lines: string[] = [];
  if (plan.summary) lines.push(`Plan: ${plan.summary}`);
  else lines.push(`Plan: ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`);
  for (const [i, step] of plan.steps.entries()) {
    const bits = [`${stepNumber(step, i)}. ${stepName(step)}${step.kind ? ` (${step.kind})` : ''}`];
    if (step.unchanged) bits.push('no change needed, 0 credits');
    else if (step.credits !== undefined) bits.push(step.creditsEstimated ? `~${creditsText(step.credits)} (listed price)` : creditsText(step.credits));
    const status = options.statuses && step.status ? STATUS_WORDS[step.status] : undefined;
    if (status) bits.push(status);
    lines.push(`  ${bits.join(' · ')}`);
    if (step.why) lines.push(`     ${step.why}`);
    if (options.basis && step.basis) lines.push(`     Basis: ${step.basis}`);
  }
  return lines;
}

/** "photo" from ./photo.jpg or https://x/y/photo.jpg?a=1; empty when nothing usable is left. */
export function sourceStem(source: string): string {
  let name: string;
  if (isRemoteUrl(source)) {
    try {
      name = decodeURIComponent(new URL(source).pathname.split('/').pop() ?? '');
    } catch {
      name = '';
    }
  } else {
    name = basename(source);
  }
  const ext = extname(name);
  return slugify(ext && ext.length <= 6 ? name.slice(0, -ext.length) : name);
}

/** image / video / audio from the file extension, when it tells. */
export function mediaTypeOf(source: string): 'image' | 'video' | 'audio' | undefined {
  let name = source;
  if (isRemoteUrl(source)) {
    try {
      name = new URL(source).pathname;
    } catch {
      return undefined;
    }
  }
  const type = contentTypeFor(name)?.split('/')[0];
  return type === 'image' || type === 'video' || type === 'audio' ? type : undefined;
}

function display(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}

/** Where step N goes: next to the final file, as <name>-step-N.<ext>. */
function stepTarget(target: OutputTarget, n: number, name: string): { target: OutputTarget; assetName?: string } {
  if (target.kind === 'dir') return { target, assetName: `${name}-step-${n}` };
  const ext = extname(target.path);
  const stem = ext ? target.path.slice(0, -ext.length) : target.path;
  // No extension: the step's own file type decides it.
  return { target: { kind: 'file', path: `${stem}-step-${n}` } };
}

/**
 * Follows the plan while the run goes: prints it once known, a line when a new
 * step starts (from the server's "Step 2/3 · ..." progress or the polled plan),
 * and remembers finished step files for Ctrl+C.
 */
class StepTracker {
  plan: EditPlan | undefined;
  private printedPlan = false;
  private lastStep = 0;

  constructor(private readonly ctx: Context) {}

  get human(): boolean {
    return !this.ctx.out.jsonMode;
  }

  printPlan(statuses = false): void {
    if (this.printedPlan || !this.plan || !this.human) return;
    this.printedPlan = true;
    for (const line of planLines(this.plan, { statuses })) this.ctx.out.line(line);
  }

  onMessage(message: string): void {
    const match = /^Step\s+(\d+)\s*\/\s*(\d+)/i.exec(message);
    if (!match) return;
    this.startStep(Number(match[1]), message);
  }

  onPayload(payload: Record<string, unknown>, open?: string): void {
    const plan = planOf(payload);
    if (!plan) return;
    this.plan = plan;
    this.printPlan();
    for (const [i, step] of plan.steps.entries()) {
      if (step.status === 'completed' && step.assetUrl) {
        addReadyResult({ assetUrl: step.assetUrl, label: `step ${stepNumber(step, i)}`, ...(open ? { openInAitopia: open } : {}) });
      }
    }
    const running = plan.steps.findIndex((s) => s.status === 'running');
    if (running >= 0) {
      const step = plan.steps[running] as PlanStep;
      const n = stepNumber(step, running);
      this.startStep(n, `Step ${n}/${plan.steps.length} · ${stepName(step)}`);
    }
  }

  private startStep(n: number, message: string): void {
    if (n <= this.lastStep) return;
    this.lastStep = n;
    if (this.human) this.ctx.out.note(message);
  }
}

interface SavedStep {
  step: number;
  assetUrl: string;
  file?: string;
}

/**
 * aitopia edit <file|url> "<instruction>": edit_media plans the steps (models,
 * store agents, ffmpeg) and runs them; the CLI shows the plan, follows the
 * steps and saves the result (and with --keep-steps every intermediate file).
 */
export async function editCommand(ctx: Context, source: string, words: string[], options: EditOptions): Promise<void> {
  const instruction = joinWords(words);
  if (!source) throw new UsageError('Give the file or URL to edit, e.g. aitopia edit photo.jpg "remove the background".');
  if (!instruction) throw new UsageError('Say what to change, e.g. aitopia edit photo.jpg "remove the background, make it 9:16".');
  const remote = isRemoteUrl(source);
  if (!remote) assertLocalFile(source);
  const { out } = ctx;
  const name = `${sourceStem(source) || slugify(instruction) || 'aitopia'}-edited`;
  if (options.plan && options.dryRun) throw new UsageError('--plan runs a plan that was already priced; leave out --dry-run.');
  // --plan: the file uploaded for the dry run (the server runs a plan only on that file URL).
  const kept = options.plan ? keptPlan(options.plan) : undefined;
  if (kept) {
    const stamp = fileStamp(source, remote);
    if (kept.source !== sourceKey(source, remote) || kept.instruction !== instruction) {
      throw new UsageError('This --plan was made for another file or instruction. Run it with the same file and words as the --dry-run, or run a new --dry-run.');
    }
    if (kept.size !== stamp.size || kept.mtimeMs !== stamp.mtimeMs) {
      throw new UsageError(`${source} has changed since the --dry-run. Run a new --dry-run.`);
    }
  }

  await withSession(ctx, async (session) => {
    let assetUrl = kept?.assetUrl ?? source;
    if (!remote && !kept) {
      if (!out.jsonMode) out.note(`Uploading ${source}...`);
      assetUrl = (await uploadSource(session.callTool, source, { allowHttpLoopback: allowHttpLoopback(ctx.serverUrl) })).assetUrl;
    }
    const args: Record<string, unknown> = { assetUrl, instruction };
    if (options.plan) args.planToken = options.plan;
    const mediaType = mediaTypeOf(source);
    if (mediaType) args.mediaType = mediaType;
    if (options.maxCredits !== undefined) args.maxCredits = options.maxCredits;
    if (options.dryRun) args.dryRun = true;

    const tracker = new StepTracker(ctx);
    const activity = startActivity(ctx, options.dryRun ? 'Planning the edit' : 'Editing');
    const onProgress = activity.callOptions.onProgress;
    activity.callOptions.onProgress = (p) => {
      onProgress?.(p);
      tracker.onMessage(progressMessage(p.message));
    };
    try {
      const first = await paidCall(options.dryRun, () =>
        session.callTool('edit_media', args, { ...activity.callOptions, paid: !options.dryRun }),
      );
      if (options.dryRun) {
        // Planning can outlast the server's inline wait: then the estimate
        // arrives through the run token like any long run.
        const estimate = isRunning(first) ? await followEstimate(ctx, session, first, activity) : first;
        activity.stop();
        const token = isFailed(estimate) ? undefined : str(estimate.payload.planToken);
        if (token) {
          const ttl = num(estimate.payload.planTokenExpiresInSec) ?? 3600;
          keepPlan(token, { assetUrl, instruction, source: sourceKey(source, remote), ...fileStamp(source, remote) }, ttl);
        }
        deliverEditEstimate(ctx, estimate, options, token ? runPlanCommand(source, instruction, token) : undefined);
        return;
      }
      const done = await followEdit(ctx, session, first, tracker, activity);
      activity.stop();
      await deliverEdit(ctx, done, tracker, options, name);
    } finally {
      activity.stop();
    }
  });
}

async function followEdit(ctx: Context, session: Session, first: ToolOutcome, tracker: StepTracker, activity: Activity): Promise<ToolOutcome> {
  tracker.onPayload(first.payload, openInAitopiaUrl(first));
  if (!isRunning(first)) return first;
  const spinner = activity.spinner();
  try {
    return await waitForRun(session.callTool, first, {
      onStart: (runToken) => {
        setActiveRun(runToken);
        ctx.out.debug(`run token: ${runToken}`);
      },
      onUpdate: (payload) => tracker.onPayload(payload),
      onProgress: (p) => {
        spinner.update(describeProgress(p, { eta: !ctx.out.stderrIsTTY }));
        spinner.setEta(p.etaSeconds);
      },
      callOptions: activity.callOptions,
      onNote: (note) => ctx.out.debug(`server: ${note}`),
    });
  } finally {
    activity.stop();
    setActiveRun(undefined);
  }
}

/** A dry run still planning: wait for its estimate (no step tracking, the plan is printed once at the end). */
async function followEstimate(ctx: Context, session: Session, first: ToolOutcome, activity: Activity): Promise<ToolOutcome> {
  try {
    return await waitForRun(session.callTool, first, {
      onStart: (runToken) => ctx.out.debug(`run token: ${runToken}`),
      callOptions: activity.callOptions,
      onNote: (note) => ctx.out.debug(`server: ${note}`),
    });
  } finally {
    activity.stop();
  }
}

function totalOf(payload: Record<string, unknown>): number | undefined {
  return num(field(payload, 'totalCredits'));
}

/** --dry-run: the plan, each step's price, the total and the balance. Exit 0, also when it is not affordable. */
function deliverEditEstimate(ctx: Context, outcome: ToolOutcome, options: EditOptions, runCommand?: string): void {
  const { out } = ctx;
  if (isFailed(outcome)) throw editFailure(ctx, outcome, options);
  const p = outcome.payload;
  if (out.jsonMode) {
    out.json(p);
    return;
  }
  const plan = planOf(p);
  if (plan) for (const line of planLines(plan, { basis: true })) out.line(line);
  const coverage = p.complete === false ? ' (not every step could be priced)' : '';
  out.line(`${out.out.bold('Total:')} ${creditsText(totalOf(p))}${coverage}`);
  const balance = isObject(p.balance) ? p.balance.creditsForGeneration : undefined;
  if (balance !== undefined && balance !== null) out.line(`Balance: ${creditsText(balance)} available`);
  if (p.affordable === false) {
    out.line(out.out.red('Not enough credits for this edit.'));
    out.line(`Buy credits: ${str(p.buyCreditsUrl) ?? buyCreditsUrl(outcome)}`);
  } else if (p.affordable === true) {
    out.line(`Affordable: ${out.out.green('yes')}`);
  } else if (typeof p.balanceNote === 'string') {
    out.note(p.balanceNote);
  }
  if (p.withinBudget === false) {
    const limit = num(p.maxCredits) ?? options.maxCredits;
    out.line(out.out.red(`Over your --max-credits limit${limit !== undefined ? ` of ${creditsText(limit)}` : ''}: it would not run.`));
  }
  out.line(out.out.dim('Nothing was run or charged.'));
  if (runCommand) {
    out.line('');
    out.line('To run exactly this plan at this price (within 1 hour):');
    out.line(`  ${runCommand}`);
  }
}

/** A shell-safe word: as is when plain, else in single quotes. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function runPlanCommand(source: string, instruction: string, token: string): string {
  // --plan=<token>: a token starting with '-' must not read as a flag.
  return ['aitopia', 'edit', shellWord(source), shellWord(instruction), `--plan=${shellWord(token)}`].join(' ');
}

/** A failure of the call itself: OVER_BUDGET shows the plan and total; others map as usual. */
function editFailure(ctx: Context, outcome: ToolOutcome, options: EditOptions, tracker?: StepTracker): CliError {
  const { out } = ctx;
  const base = failureToError(outcome.payload, { buyCreditsUrl: buyCreditsUrl(outcome), openInAitopia: openInAitopiaUrl(outcome) });
  if (base.code === 'POLL_FAILED') return pollFailed(outcome.payload, base.message, openInAitopiaUrl(outcome));
  if (base.code !== 'OVER_BUDGET' && base.code !== 'PRICE_UNKNOWN') return base;
  const plan = planOf(outcome.payload);
  const total = totalOf(outcome.payload);
  if (tracker) tracker.printPlan();
  else if (!out.jsonMode && plan) for (const line of planLines(plan, { basis: true })) out.line(line);
  if (!out.jsonMode && total !== undefined) out.line(`${out.out.bold('Total:')} ${creditsText(total)}`);
  const data = { ...outcome.payload, ...(plan ? { plan } : {}), ...(total !== undefined ? { totalCredits: total } : {}) };
  if (base.code === 'PRICE_UNKNOWN') {
    return new CliError(base.message, EXIT.FAILED, {
      code: 'PRICE_UNKNOWN',
      hint: 'A step in the plan has no listed price, so the edit was not started. Nothing ran or was charged.',
      data,
    });
  }
  const limit = num(field(outcome.payload, 'maxCredits')) ?? options.maxCredits;
  const message = `This edit needs ${creditsText(total)}${limit !== undefined ? `, more than your limit of ${creditsText(limit)}` : ', more than your limit'}.`;
  return new CliError(message, EXIT.FAILED, {
    code: 'OVER_BUDGET',
    hint: 'Nothing ran and nothing was charged. Raise --max-credits, or ask for fewer changes.',
    data,
  });
}

/** POLL_FAILED: a step's provider could not be checked; it may still finish (exit 5). */
function pollFailed(payload: Record<string, unknown>, message: string, open?: string, data: Record<string, unknown> = {}): CliError {
  const runToken = str(payload.runToken);
  return new CliError(message, EXIT.PENDING, {
    code: 'POLL_FAILED',
    hint: 'The step may still finish (and be charged). Check Open in AITOPIA before running it again.',
    notes: [`Open in AITOPIA: ${open ?? 'https://aitopia.ai/creations'}`, ...(runToken ? [`Check it with: aitopia status ${runToken} --wait`] : [])],
    data: { ...payload, ...data },
  });
}

/** Downloads one file; never throws (a failed download is reported, the result was paid for). */
async function save(
  ctx: Context,
  url: string,
  where: { target: OutputTarget; assetName?: string },
  options: EditOptions,
): Promise<{ file?: string; error?: string }> {
  try {
    ctx.out.debug(`downloading ${url}`);
    const file = await downloadAsset(url, {
      target: where.target,
      index: 0,
      total: 1,
      assetName: where.assetName,
      force: options.force === true,
      allowHttpLoopback: allowHttpLoopback(ctx.serverUrl),
    });
    return { file };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Step number: the server's 1-based `index`, else the position in the plan. */
export function stepNumber(step: PlanStep, position: number): number {
  return step.index !== undefined && step.index >= 1 ? step.index : position + 1;
}

/**
 * Files of the finished steps, in order: a partial answer's `items`, else the
 * plan's completed steps. `skipUrl` (the final result) is left out.
 */
function finishedSteps(payload: Record<string, unknown>, plan: EditPlan | undefined, skipUrl?: string): SavedStep[] {
  const items = Array.isArray(payload.items) ? payload.items.filter(isObject) : undefined;
  const list: Array<{ step: number; assetUrl?: string }> = items
    ? items
        .filter((item) => item.status === undefined || item.status === 'completed')
        .map((item, i) => ({ step: num(item.index) ?? i + 1, assetUrl: str(item.assetUrl) }))
    : (plan?.steps ?? []).map((step, i) => ({ step: stepNumber(step, i), assetUrl: step.status === 'completed' ? step.assetUrl : undefined }));
  return list.filter((s): s is SavedStep => Boolean(s.assetUrl) && s.assetUrl !== skipUrl);
}

/** Saves the given finished steps as <name>-step-N (or prints their URLs with --no-download). */
async function saveSteps(
  ctx: Context,
  chosen: SavedStep[],
  target: OutputTarget,
  name: string,
  options: EditOptions,
  open?: string,
): Promise<{ saved: SavedStep[]; errors: string[] }> {
  const saved: SavedStep[] = [];
  const errors: string[] = [];
  for (const item of chosen) {
    const entry = addReadyResult({ assetUrl: item.assetUrl, label: `step ${item.step}`, ...(open ? { openInAitopia: open } : {}) });
    if (options.download === false) {
      saved.push(item);
      if (!ctx.out.jsonMode) ctx.out.line(`Step ${item.step}: ${item.assetUrl}`);
      continue;
    }
    const result = await save(ctx, item.assetUrl, stepTarget(target, item.step, name), options);
    if (result.file) {
      entry.file = result.file;
      saved.push({ ...item, file: result.file });
      if (!ctx.out.jsonMode) ctx.out.line(`${ctx.out.out.green('Saved')} ${display(result.file)} (step ${item.step})`);
    } else {
      saved.push(item);
      errors.push(`step ${item.step}: ${result.error ?? 'download failed'}`);
      if (!ctx.out.jsonMode) ctx.out.note(ctx.out.err.red(`Could not download step ${item.step}: ${result.error}`) + `\n  ${item.assetUrl}`);
    }
  }
  return { saved, errors };
}

/** The plan with the saved file of each step (for --json). */
function planWithFiles(plan: EditPlan | undefined, saved: SavedStep[]): EditPlan | undefined {
  if (!plan) return undefined;
  const files = new Map(saved.filter((s) => s.file).map((s) => [s.step, s.file as string]));
  return {
    ...plan,
    steps: plan.steps.map((step, i) => {
      const file = files.get(stepNumber(step, i));
      return file ? { ...step, file } : step;
    }),
  };
}

/** "Step 2 (Topaz Image Upscale) failed" from failedStep (a number or a step object) or the plan's failed step. */
function failedStepLabel(payload: Record<string, unknown>, plan: EditPlan | undefined): string {
  const raw = field(payload, 'failedStep');
  const steps = plan?.steps ?? [];
  let n = num(raw) ?? (isObject(raw) ? num(raw.index) : undefined);
  let step = n !== undefined ? steps.find((s, i) => stepNumber(s, i) === n) : undefined;
  if (!step) {
    const at = steps.findIndex((s) => s.status === 'failed');
    if (at >= 0) {
      step = steps[at];
      n ??= stepNumber(step as PlanStep, at);
    }
  }
  const shown = (isObject(raw) ? str(raw.displayName) : undefined) ?? (step ? stepName(step) : undefined);
  if (n === undefined) return 'A step failed';
  return `Step ${n}${shown ? ` (${shown})` : ''} failed`;
}

async function deliverEdit(ctx: Context, outcome: ToolOutcome, tracker: StepTracker, options: EditOptions, name: string): Promise<void> {
  const { out } = ctx;
  const p = outcome.payload;
  const plan = planOf(p) ?? tracker.plan;
  tracker.plan = plan;
  const open = openInAitopiaUrl(outcome);
  const target = resolveOutputTarget(options.output);

  if (isFailed(outcome)) {
    // A hard failure: nothing ran (OVER_BUDGET, PLAN_UNAVAILABLE, ...).
    const error = editFailure(ctx, outcome, options, tracker);
    tracker.printPlan(true);
    throw error;
  }

  if (p.status === 'partial') {
    // A step failed mid-chain: the steps before it finished and were paid for.
    tracker.printPlan(true);
    const code = str(p.code)?.toUpperCase() ?? 'STEP_FAILED';
    const reason = str(p.error) ?? 'The step failed.';
    const where = failedStepLabel(p, plan);
    const finished = finishedSteps(p, plan);
    const lastUrl = str(p.lastAssetUrl);
    const last = finished.find((s) => s.assetUrl === lastUrl) ?? finished[finished.length - 1] ?? (lastUrl ? { step: 0, assetUrl: lastUrl } : undefined);
    const chosen = options.keepSteps ? finished : last ? [last] : [];
    const { saved, errors } = await saveSteps(ctx, chosen, target, name, options, open);
    const files = saved.map((s) => s.file).filter((f): f is string => Boolean(f));
    const notes: string[] = [];
    if (code === 'INSUFFICIENT_CREDITS') notes.push(`Buy credits: ${buyCreditsUrl(outcome)}`);
    const partialData = { status: 'partial', ...(plan ? { plan: planWithFiles(plan, saved) } : {}), files, ...(errors.length > 0 ? { downloadErrors: errors } : {}) };
    if (code === 'POLL_FAILED') throw pollFailed(p, `${where.replace(/ failed$/, '')} could not be checked: ${reason}`, open, partialData);
    if (open) notes.push(`Open in AITOPIA: ${open}`);
    throw new CliError(`${where}: ${reason}`, exitCodeFor(code, reason), {
      code,
      hint:
        finished.length > 0
          ? 'The steps before it finished and are saved (and in AITOPIA); they were paid for, so do not run them again. Nothing after the failed step ran.'
          : 'Nothing after the failed step ran.',
      notes,
      data: { ...p, status: 'partial', ...(plan ? { plan: planWithFiles(plan, saved) } : {}), files, ...(errors.length > 0 ? { downloadErrors: errors } : {}) },
    });
  }

  const finalUrl = str(p.assetUrl) ?? assetsOf(outcome)[0]?.url;
  if (!out.jsonMode && plan) tracker.printPlan(true);
  if (!out.jsonMode && p.noTransformNeeded === true) out.line('The file was already in the requested form; nothing needed changing.');
  const files: string[] = [];
  const downloadErrors: string[] = [];
  if (finalUrl) {
    const entry = addReadyResult({ assetUrl: finalUrl, ...(str(p.assetName) ? { name: str(p.assetName) } : {}), ...(open ? { openInAitopia: open } : {}) });
    if (options.download === false) {
      if (!out.jsonMode) out.line(finalUrl);
    } else {
      const result = await save(ctx, finalUrl, target.kind === 'dir' ? { target, assetName: name } : { target }, options);
      if (result.file) {
        entry.file = result.file;
        files.push(result.file);
        if (!out.jsonMode) out.line(`${out.out.green('Saved')} ${display(result.file)}`);
      } else {
        downloadErrors.push(`result: ${result.error ?? 'download failed'}`);
        if (!out.jsonMode) {
          out.note(out.err.red(`Could not download the result: ${result.error}`));
          out.line(finalUrl);
        }
      }
    }
  } else {
    out.warn('The edit finished but returned no file.');
  }

  let saved: SavedStep[] = [];
  if (options.keepSteps) {
    const steps = await saveSteps(ctx, finishedSteps(p, plan, finalUrl), target, name, options, open);
    saved = steps.saved;
    downloadErrors.push(...steps.errors);
    files.push(...saved.map((s) => s.file).filter((f): f is string => Boolean(f)));
  }

  const total = totalOf(p);
  if (out.jsonMode) {
    if (downloadErrors.length === 0) {
      out.json({ ...p, ...(plan ? { plan: planWithFiles(plan, saved) } : {}), files });
      return;
    }
  } else {
    if (total !== undefined) out.line(`Total: ${creditsText(total)}`);
    if (open) out.line(`${out.out.dim('Open in AITOPIA:')} ${open}`);
  }
  if (downloadErrors.length > 0) {
    throw new CliError(`Could not download ${downloadErrors.length === 1 ? 'a file' : `${downloadErrors.length} files`}: ${downloadErrors.join('; ')}`, EXIT.FAILED, {
      code: 'DOWNLOAD_FAILED',
      hint: 'The edit is done and paid for; do not run it again. Download the files from the URLs above or from AITOPIA.',
      data: { ...p, ...(plan ? { plan: planWithFiles(plan, saved) } : {}), files, downloadErrors },
    });
  }
}
