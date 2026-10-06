import { parseSetPairs } from '../args.js';
import type { Context } from '../context.js';
import { failureToError } from '../errors.js';
import { isFailed, type ToolOutcome } from '../envelope.js';
import { inFlight } from '../interrupt.js';
import type { CallOptions, Session } from '../mcp.js';
import type { ScopeOptions } from '../resolve.js';
import { deliver, deliverEstimate, settle, startActivity, type DeliverOptions } from '../results.js';
import {
  ASPECT_FIELDS,
  applySetFields,
  mapFlag,
  modelsFromPayload,
  pickModel,
  schemaFromPayload,
  type GenerationKind,
  type ModelSchema,
} from '../schema.js';

export interface GenerateOptions extends DeliverOptions, ScopeOptions {
  model?: string;
  name?: string;
  set?: string[];
  /** Price check only (dryRun): nothing is submitted or charged. */
  dryRun?: boolean;
}

/** A paid call, or with --dry-run a free price check (not marked in flight). */
export function paidCall<T>(dryRun: boolean | undefined, fn: () => Promise<T>): Promise<T> {
  return dryRun ? fn() : inFlight(fn);
}

/** Models listed to choose from when --model is not given. */
export const PICK_LIST_LIMIT = 20;

export async function fetchSchema(session: Session, modelId: string): Promise<ModelSchema> {
  const outcome = await session.callTool('get_model_schema', { modelId });
  if (isFailed(outcome)) throw failureToError(outcome.payload);
  return schemaFromPayload(outcome.payload);
}

/** Lists models of a media type and picks one (see pickModel). Undefined when the list gives nothing usable. */
export async function chooseModel(session: Session, kind: GenerationKind): Promise<string | undefined> {
  const type = kind === 'image' || kind === 'audio' ? kind : 'video';
  const outcome = await session.callTool('list_models', { type, limit: PICK_LIST_LIMIT });
  if (isFailed(outcome)) throw failureToError(outcome.payload);
  return pickModel(modelsFromPayload(outcome.payload), kind);
}

/** Prints the model that will be used (human mode only). */
export function announceModel(ctx: Context, modelId: string): void {
  if (!ctx.out.jsonMode) ctx.out.note(`Model: ${modelId}`);
}

/**
 * Arguments for generate_image / generate_audio. allowAnyModel is set only when
 * the user named the model with --model; --set fields go into `input`.
 */
export function generationArgs(
  prompt: string,
  options: GenerateOptions,
  modelId: string | undefined,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const args: Record<string, unknown> = { prompt, ...extra };
  if (options.name) args.assetName = options.name;
  if (modelId) args.selectedModelId = modelId;
  if (options.model) args.allowAnyModel = true;
  if (Object.keys(input).length > 0) args.input = input;
  return args;
}

/**
 * `input` for a generation: --aspect mapped onto the model's own field and
 * --set fields checked against its schema. The schema is fetched only when
 * one of those is given.
 */
export async function buildInput(
  session: Session,
  modelId: string | undefined,
  options: GenerateOptions & { aspect?: string },
): Promise<Record<string, unknown>> {
  const sets = parseSetPairs(options.set);
  const needsSchema = options.aspect !== undefined || Object.keys(sets).length > 0;
  if (!modelId || !needsSchema) {
    return { ...(options.aspect !== undefined ? { aspect_ratio: options.aspect } : {}), ...sets };
  }
  const schema = await fetchSchema(session, modelId);
  const base: Record<string, unknown> = {};
  if (options.aspect !== undefined) {
    const [field, value] = mapFlag(schema, modelId, '--aspect', ASPECT_FIELDS, options.aspect);
    base[field] = value;
  }
  return applySetFields(modelId, schema, base, sets);
}

/** The first suggested model id of a MODEL_REQUIRED answer. */
export function suggestedModel(outcome: ToolOutcome): string | undefined {
  if (!isFailed(outcome) || outcome.payload.code !== 'MODEL_REQUIRED') return undefined;
  const suggestions = outcome.payload.suggestions;
  const first: unknown = Array.isArray(suggestions) ? suggestions[0] : undefined;
  if (typeof first === 'string' && first) return first;
  if (first && typeof first === 'object' && typeof (first as { id?: unknown }).id === 'string') return (first as { id: string }).id;
  return undefined;
}

/**
 * Picks the model (unless --model), builds the input and calls the tool. If
 * the server still answers MODEL_REQUIRED (nothing was spent), it is called
 * once more with the server's first suggestion.
 */
export async function runGeneration(
  ctx: Context,
  session: Session,
  tool: 'generate_image' | 'generate_audio',
  kind: 'image' | 'audio',
  prompt: string,
  options: GenerateOptions & { aspect?: string },
  extra: Record<string, unknown> = {},
  callOptions?: CallOptions,
): Promise<ToolOutcome> {
  const flags = options.dryRun ? { ...extra, dryRun: true } : extra;
  // A saved voice brings its own speech model.
  const voice = typeof extra.voiceId === 'string';
  let modelId = options.model ?? (voice ? undefined : await chooseModel(session, kind));
  if (modelId && !options.model) announceModel(ctx, modelId);
  const input = await buildInput(session, modelId, options);
  const first = await paidCall(options.dryRun, () =>
    session.callTool(tool, generationArgs(prompt, options, modelId, input, flags), { ...callOptions, paid: !options.dryRun }),
  );
  const suggestion = options.model || voice ? undefined : suggestedModel(first);
  if (!suggestion || suggestion === modelId) return first;
  modelId = suggestion;
  announceModel(ctx, modelId);
  const retryInput = await buildInput(session, modelId, options);
  return paidCall(options.dryRun, () =>
    session.callTool(tool, generationArgs(prompt, options, modelId, retryInput, flags), { ...callOptions, paid: !options.dryRun }),
  );
}

/** image / audio: generate (or price with --dry-run), wait with live progress, deliver. */
export async function generateAndDeliver(
  ctx: Context,
  session: Session,
  tool: 'generate_image' | 'generate_audio',
  kind: 'image' | 'audio',
  prompt: string,
  options: GenerateOptions & { aspect?: string },
  extra: Record<string, unknown>,
  label: string,
  /** Sees the first answer and the finished one (e.g. to print a server note). */
  onAnswer?: (outcome: ToolOutcome) => void,
): Promise<void> {
  const activity = startActivity(ctx, options.dryRun ? 'Checking the price' : label);
  try {
    const first = await runGeneration(ctx, session, tool, kind, prompt, options, extra, activity.callOptions);
    onAnswer?.(first);
    if (options.dryRun) {
      activity.stop();
      deliverEstimate(ctx, first);
      return;
    }
    const done = await settle(ctx, session, first, label, activity);
    onAnswer?.(done);
    await deliver(ctx, done, options, { expectFiles: true, prompt: options.name ?? prompt });
  } finally {
    activity.stop();
  }
}

/**
 * One named tool (generate_video, upscale_image, ...): call it (or price it with
 * dryRun), follow a runToken with live progress, then save the files.
 * `args` already holds dryRun when it is a price check.
 */
export async function runToolAndDeliver(
  ctx: Context,
  session: Session,
  tool: string,
  args: Record<string, unknown>,
  options: DeliverOptions & { dryRun?: boolean },
  label: string,
  name: string,
  /** Sees the first answer (e.g. to print the model the server picked). */
  onFirst?: (outcome: ToolOutcome) => void,
): Promise<void> {
  const activity = startActivity(ctx, options.dryRun ? 'Checking the price' : label);
  try {
    const first = await paidCall(options.dryRun, () => session.callTool(tool, args, { ...activity.callOptions, paid: !options.dryRun }));
    onFirst?.(first);
    if (options.dryRun) {
      activity.stop();
      deliverEstimate(ctx, first);
      return;
    }
    const done = await settle(ctx, session, first, label, activity);
    await deliver(ctx, done, options, { expectFiles: true, prompt: name });
  } finally {
    activity.stop();
  }
}
