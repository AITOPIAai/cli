import { readFileSync, statSync } from 'node:fs';
import { parseObjectJson, parseSetPairs } from '../args.js';
import { withSession, type Context } from '../context.js';
import { CliError, EXIT, UsageError, failureToError, formatNumber, statusNotes } from '../errors.js';
import { assetsOf, isFailed, type ToolOutcome } from '../envelope.js';
import type { Session } from '../mcp.js';
import { renderTable } from '../output.js';
import { isRunning } from '../poll.js';
import { checkScopeOptions, matchNamed, resolveScope, type Named, type ScopeOptions } from '../resolve.js';
import { allowHttpLoopback, creditsText, deliver, deliverEstimate, settle, startActivity, type DeliverOptions } from '../results.js';
import { coerceValue, fieldNames, schemaFromPayload, type ModelSchema, type SchemaField } from '../schema.js';
import { assertLocalFile, isRemoteUrl, uploadSource } from '../upload.js';
import { describeField } from './models.js';
import { paidCall } from './generate.js';

/** Agents listed per page when --limit is not given. */
export const AGENTS_PAGE_SIZE = 30;

/** Stands in for a local file on --dry-run (the listed price does not depend on it; nothing is uploaded). */
export const DRY_RUN_FILE_URL = 'https://example.invalid/local-file';

/** A store agent as list_store_agents describes it. */
export type StoreAgent = Named & Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function storeAgents(payload: Record<string, unknown>): StoreAgent[] {
  const list = Array.isArray(payload.agents) ? payload.agents : [];
  return list.filter(isObject).flatMap((a) => (typeof a.id === 'string' && a.id ? [{ ...a, id: a.id, name: str(a.name) || a.id }] : []));
}

/** "1 credit", "1-5 credits", or '' when the agent lists no price. */
export function agentPrice(agent: Record<string, unknown>): string {
  const estimate = isObject(agent.creditsEstimated) ? agent.creditsEstimated : {};
  const min = num(estimate.min);
  const max = num(estimate.max);
  if (min === undefined && max === undefined) return '';
  if (min === undefined || max === undefined || min === max) return creditsText(min ?? max);
  return `${formatNumber(min)}-${creditsText(max)}`;
}

function seconds(value: number): string {
  return value >= 120 ? `${Math.round(value / 60)} min` : `${value} s`;
}

/** "5-60 s", "up to 8 min", or '' when unknown. */
function agentDuration(agent: Record<string, unknown>): string {
  const duration = isObject(agent.estimatedDuration) ? agent.estimatedDuration : {};
  const min = num(duration.min);
  const max = num(duration.max);
  if (max === undefined) return min === undefined ? '' : `about ${seconds(min)}`;
  if (!min) return `up to ${seconds(max)}`;
  if (min === max) return `about ${seconds(max)}`;
  return max >= 120 ? `${seconds(min)} to ${seconds(max)}` : `${min}-${max} s`;
}

function shortText(text: unknown): string {
  return str(text).replace(/\s+/g, ' ').trim();
}

async function listStoreAgents(session: Session, args: Record<string, unknown> = {}): Promise<{ payload: Record<string, unknown>; agents: StoreAgent[] }> {
  const outcome = await session.callTool('list_store_agents', args);
  if (isFailed(outcome)) throw failureToError(outcome.payload);
  return { payload: outcome.payload, agents: storeAgents(outcome.payload) };
}

export interface AgentsOptions {
  q?: string;
  category?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
}

export function agentRows(agents: StoreAgent[]): string[][] {
  const rows: string[][] = [['ID', 'NAME', 'CREDITS', 'DESCRIPTION']];
  for (const agent of agents) rows.push([agent.id, agent.name, agentPrice(agent) || '-', shortText(agent.description)]);
  return rows;
}

/** aitopia agents: the store agents (list_store_agents), searched and paged. */
export async function agentsCommand(ctx: Context, options: AgentsOptions): Promise<void> {
  await withSession(ctx, async (session) => {
    const args: Record<string, unknown> = {};
    if (options.q?.trim()) args.q = options.q.trim();
    if (options.category?.trim()) args.category = options.category.trim();
    const { payload, agents } = await listStoreAgents(session, args);
    // list_store_agents answers every match at once: page here.
    const offset = options.offset ?? 0;
    const end = options.all ? agents.length : offset + (options.limit ?? AGENTS_PAGE_SIZE);
    const page = agents.slice(offset, end);
    const nextOffset = end < agents.length ? end : undefined;
    const { out } = ctx;
    if (out.jsonMode) {
      out.json({ ...payload, agents: page, returned: page.length, total: agents.length, offset, ...(nextOffset !== undefined ? { nextOffset } : {}) });
      return;
    }
    if (page.length === 0) {
      out.line(agents.length > 0 ? `No store agents after --offset ${offset} (${agents.length} found).` : 'No store agents found.');
      if (args.q || args.category) out.note('Try other words with --q, or list them all with `aitopia agents`.');
      return;
    }
    const rows = agentRows(page);
    const widths = [40, 32, 14].map((max, i) => Math.min(max, Math.max(...rows.map((r) => (r[i] ?? '').length))));
    const descWidth = Math.max(20, out.columns - widths.reduce((a, b) => a + b, 0) - 6);
    for (const row of renderTable(rows, [...widths, descWidth])) out.line(row);
    if (nextOffset !== undefined) out.note(`Showing ${page.length} of ${agents.length}. Next page: --offset ${nextOffset}`);
    out.note('Show one with: aitopia agent <id>');
  });
}

export function agentNotFound(ref: string, agents: StoreAgent[]): CliError {
  const wanted = ref.trim().toLowerCase();
  const near = agents.filter((a) => a.id.toLowerCase().includes(wanted) || a.name.toLowerCase().includes(wanted)).slice(0, 5);
  return new CliError(`No store agent named "${ref.trim()}".`, EXIT.FAILED, {
    code: 'AGENT_NOT_FOUND',
    hint: 'Search with `aitopia agents --q <words>` and use an id it shows. Nothing was spent.',
    notes: near.length > 0 ? [`Did you mean: ${near.map((a) => `${a.id} (${a.name})`).join(', ')}`] : [],
  });
}

/** A store agent by its exact id, else its name (any case); several equal names exit 2 listing the ids. */
export async function resolveAgent(session: Session, ref: string): Promise<StoreAgent> {
  if (!ref.trim()) throw new UsageError('A store agent id or name is required.', 'List them with `aitopia agents`.');
  const { agents } = await listStoreAgents(session);
  const found = matchNamed(agents, ref, 'store agent');
  if (!found) throw agentNotFound(ref, agents);
  return found;
}

/** get_store_agent_schema: {agentId, input: {properties, required}, output}. */
async function agentSchema(session: Session, agentId: string): Promise<{ payload: Record<string, unknown>; schema: ModelSchema }> {
  const outcome = await session.callTool('get_store_agent_schema', { agentId });
  if (isFailed(outcome)) throw failureToError(outcome.payload);
  const input = isObject(outcome.payload.input) ? outcome.payload.input : {};
  return { payload: outcome.payload, schema: schemaFromPayload(input) };
}

const FILE_WIDGETS = new Set(['media', 'multi_image', 'multi_video', 'multi_audio']);
const FILE_COMPONENTS = new Set(['file-upload', 'multi-file-upload']);

/**
 * The kind of file a field takes ("image", "video", "audio" or "file"), from
 * its x-uap upload widget; undefined for any other field.
 */
export function fileFieldKind(field: SchemaField | undefined): string | undefined {
  if (!field) return undefined;
  const uap = isObject(field['x-uap']) ? field['x-uap'] : {};
  const widget = str(uap.widget);
  const isFile = FILE_WIDGETS.has(widget) || FILE_COMPONENTS.has(str(uap.ui_component)) || Boolean(str(uap.mediaKind));
  if (isFile) return str(uap.mediaKind) || /^multi_(\w+)$/.exec(widget)?.[1] || 'file';
  // A URL field counts only when its text says it takes media (not, say, a web page).
  const format = str(field.format ?? field.items?.format);
  if (format !== 'uri' && format !== 'url') return undefined;
  const media = MEDIA_HINT.exec(`${str(field.title)} ${str(field.description)}`)?.[1]?.toLowerCase();
  if (!media) return undefined;
  return media === 'photo' ? 'image' : ['image', 'video', 'audio'].includes(media) ? media : 'file';
}

const MEDIA_HINT = /\b(image|photo|video|audio|file|upload)s?\b/i;

function isArrayField(field: SchemaField | undefined): boolean {
  const type = field?.type;
  return Array.isArray(type) ? type.includes('array') : type === 'array';
}

function typeLabel(field: SchemaField): string | undefined {
  const kind = fileFieldKind(field);
  if (kind) return `${isArrayField(field) ? 'files' : 'file'} (${kind})`;
  if (field.format === 'uri') return 'url';
  return undefined;
}

/** aitopia agent <id|name>: description, price and input fields. */
export async function agentShowCommand(ctx: Context, ref: string): Promise<void> {
  await withSession(ctx, async (session) => {
    const agent = await resolveAgent(session, ref);
    const { payload, schema } = await agentSchema(session, agent.id);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json({ agent, ...payload });
      return;
    }
    out.line(`${out.out.bold(agent.name)} (${agent.id})`);
    const description = shortText(agent.description);
    if (description) out.line(description);
    const facts: string[] = [];
    if (agent.category) facts.push(`Category: ${str(agent.category)}`);
    facts.push(`Price: ${agentPrice(agent) || 'not listed'}`);
    const duration = agentDuration(agent);
    if (duration) facts.push(`Takes: ${duration}${agent.async === true ? ' (runs in the background)' : ''}`);
    out.line(facts.join('   '));
    const names = fieldNames(schema);
    if (names.length === 0) {
      out.line('This agent lists no input fields.');
    } else {
      out.line('');
      out.line('Input fields (* = required):');
      const required = new Set(schema.required);
      for (const name of names) {
        const field = schema.properties[name] ?? {};
        const shown = { ...field, description: field.description ?? field.title };
        for (const line of describeField(name, shown, required.has(name), typeLabel(field))) out.line(line);
      }
    }
    out.line('');
    const example = schema.required
      .filter((name) => schema.properties[name]?.default === undefined)
      .map((name) => ` --set ${name}=${fileFieldKind(schema.properties[name]) ? '<file>' : '<value>'}`)
      .join('');
    out.line(out.out.dim(`Run it with: aitopia agent run ${agent.id}${example} --dry-run`));
    if (names.some((name) => fileFieldKind(schema.properties[name]))) {
      out.line(out.out.dim('A local file given for a file field is uploaded first.'));
    }
  });
}

/** --input: a JSON object, or @file ("@-" for stdin). */
export function parseInputOption(value: string | undefined, readFile: (path: string) => string = defaultReadFile): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value.startsWith('@')) return parseObjectJson(value, '--input');
  const path = value.slice(1);
  if (!path) throw new UsageError('--input @ needs a file name, e.g. --input @input.json (or @- for stdin).');
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    throw new UsageError(`Cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  return parseObjectJson(text, path === '-' ? 'stdin' : path);
}

function defaultReadFile(path: string): string {
  return readFileSync(path === '-' ? 0 : path, 'utf8');
}

/**
 * The agent's input: --input, then --set on top (fitted to the field types).
 * Unknown fields and missing required ones are usage errors (exit 2), found
 * before anything is uploaded or run. A required field left out that has a
 * default is sent with it.
 */
export function buildAgentInput(
  agentId: string,
  schema: ModelSchema,
  base: Record<string, unknown>,
  sets: Record<string, unknown>,
): Record<string, unknown> {
  const names = fieldNames(schema);
  const input: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(sets)) input[key] = coerceValue(schema.properties[key], value);
  if (names.length === 0) return input;
  const unknown = Object.keys(input).filter((key) => !names.includes(key));
  if (unknown.length > 0) {
    const label = unknown.length === 1 ? 'field' : 'fields';
    throw new UsageError(`Store agent ${agentId} has no ${label} ${unknown.map((u) => `"${u}"`).join(', ')}.`, `Its fields are: ${names.join(', ')}. See them with \`aitopia agent ${agentId}\`.`);
  }
  const missing: string[] = [];
  for (const name of schema.required) {
    const value = input[name];
    if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)) continue;
    const fallback = schema.properties[name]?.default;
    if (fallback !== undefined) input[name] = fallback;
    else missing.push(name);
  }
  if (missing.length > 0) {
    const label = missing.length === 1 ? 'field' : 'fields';
    const example = missing.map((name) => `--set ${name}=${fileFieldKind(schema.properties[name]) ? '<file>' : '<value>'}`).join(' ');
    throw new UsageError(
      `Store agent ${agentId} needs the ${label} ${missing.map((m) => `"${m}"`).join(', ')}.`,
      `Add ${example} (see \`aitopia agent ${agentId}\`). Nothing was uploaded, run or charged.`,
    );
  }
  return input;
}

/** An existing regular file that looks like a path (has a separator or a file extension). */
function looksLikeLocalFile(value: string): boolean {
  if (!value || isRemoteUrl(value) || value.includes('\n')) return false;
  if (!/[\\/]/.test(value) && !/\.\w{1,8}$/.test(value)) return false;
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

/**
 * Only file fields take a local file (it is uploaded). A local path given to
 * any other field, typed or not, is a usage error (exit 2) before anything is
 * uploaded or run: such a field takes text, not a file.
 */
export function checkNoFilesInTextFields(agentId: string, schema: ModelSchema, input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    if (fileFieldKind(schema.properties[key]) !== undefined) continue;
    const path = (Array.isArray(value) ? value : [value]).find((v): v is string => typeof v === 'string' && looksLikeLocalFile(v));
    if (path === undefined) continue;
    throw new UsageError(
      `The field "${key}" of store agent ${agentId} takes text, not a file (got the local file ${path}).`,
      `Pass the text itself, e.g. --set ${key}="$(cat ${path})". Nothing was uploaded, run or charged.`,
    );
  }
}

/**
 * Local files in the input: every non-URL value of a file field (it must
 * exist) is uploaded once (with --dry-run only checked, and a placeholder URL
 * sent instead). Other fields are passed as they are.
 */
export async function uploadAgentFiles(
  ctx: Context,
  session: Session,
  schema: ModelSchema,
  input: Record<string, unknown>,
  dryRun: boolean,
): Promise<Record<string, unknown>> {
  const uploaded = new Map<string, string>();
  const upload = async (path: string): Promise<string> => {
    assertLocalFile(path);
    if (dryRun) return DRY_RUN_FILE_URL;
    const known = uploaded.get(path);
    if (known) return known;
    ctx.out.note(`Uploading ${path}...`);
    const url = (await uploadSource(session.callTool, path, { allowHttpLoopback: allowHttpLoopback(ctx.serverUrl) })).assetUrl;
    uploaded.set(path, url);
    return url;
  };
  const fit = async (value: unknown, isFile: boolean): Promise<unknown> =>
    isFile && typeof value === 'string' && value.trim() !== '' && !isRemoteUrl(value) ? upload(value) : value;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const isFile = fileFieldKind(schema.properties[key]) !== undefined;
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) items.push(await fit(item, isFile));
      out[key] = items;
    } else {
      out[key] = await fit(value, isFile);
    }
  }
  return out;
}

export interface AgentRunOptions extends DeliverOptions, ScopeOptions {
  set?: string[];
  /** A JSON object or @file */
  input?: string;
  name?: string;
  /** Price check only (dryRun): nothing is uploaded, submitted or charged. */
  dryRun?: boolean;
  /** false with --no-wait: return after the run is started. */
  wait?: boolean;
}

/** Prints what an agent answered when it made no file (text, or JSON). */
function printOutput(ctx: Context, outcome: ToolOutcome): void {
  const output = outcome.payload.output;
  const empty = output === undefined || output === null || (typeof output === 'string' && !output.trim()) || (isObject(output) && Object.keys(output).length === 0);
  if (empty) {
    ctx.out.warn('The agent finished but returned no output. The full result is below.');
    ctx.out.line(JSON.stringify(outcome.payload, null, 2));
    return;
  }
  ctx.out.line(typeof output === 'string' ? output.trim() : JSON.stringify(output, null, 2));
}

/** aitopia agent run <id|name>: run a store agent (or price it with --dry-run), follow it, save its files. */
export async function agentRunCommand(ctx: Context, ref: string, options: AgentRunOptions): Promise<void> {
  // Everything that can be checked offline, before connecting.
  const base = parseInputOption(options.input);
  const sets = parseSetPairs(options.set);
  checkScopeOptions(options);
  const { out } = ctx;

  await withSession(ctx, async (session) => {
    const agent = await resolveAgent(session, ref);
    const { schema } = await agentSchema(session, agent.id);
    const checked = buildAgentInput(agent.id, schema, base, sets);
    checkNoFilesInTextFields(agent.id, schema, checked);
    // A project that does not exist stops here, before any upload.
    const scope = await resolveScope(ctx, session, options);
    const input = await uploadAgentFiles(ctx, session, schema, checked, options.dryRun === true);

    const args: Record<string, unknown> = { agentId: agent.id, input, ...scope };
    if (options.name) args.assetName = options.name;
    if (options.dryRun) args.dryRun = true;
    if (!options.dryRun && !out.jsonMode) {
      const price = agentPrice(agent);
      out.note(`Running ${agent.name} (${agent.id}) · ${price ? `listed price ${price}` : 'no listed price'}`);
    }

    const label = `Running ${agent.name}`;
    const activity = startActivity(ctx, options.dryRun ? 'Checking the price' : label);
    try {
      const first = await paidCall(options.dryRun, () => session.callTool('run_store_agent', args, { ...activity.callOptions, paid: !options.dryRun }));
      if (options.dryRun) {
        activity.stop();
        deliverEstimate(ctx, first);
        return;
      }
      if (options.wait === false && isRunning(first)) {
        activity.stop();
        const token = typeof first.payload.runToken === 'string' ? first.payload.runToken : undefined;
        throw new CliError(`${agent.name} is running in AITOPIA.`, EXIT.PENDING, {
          code: 'RUNNING',
          notes: token ? statusNotes(token) : [str(first.payload.note) || 'It appears in AITOPIA when it finishes.'],
          data: first.payload,
        });
      }
      const done = await settle(ctx, session, first, label, activity);
      if (!out.jsonMode && assetsOf(done).length === 0) printOutput(ctx, done);
      await deliver(ctx, done, options, { prompt: options.name ?? agent.name });
    } finally {
      activity.stop();
    }
  });
}
