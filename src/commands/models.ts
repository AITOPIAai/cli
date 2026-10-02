import { withSession, type Context } from '../context.js';
import { failureToError } from '../errors.js';
import { isFailed } from '../envelope.js';
import { renderTable } from '../output.js';
import { fieldNames, schemaFromPayload } from '../schema.js';

export interface ModelsOptions {
  type?: string;
  q?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
}

export const MODEL_TYPES = ['image', 'video', 'audio', 'text'];

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

export function modelRows(models: unknown[]): string[][] {
  const rows: string[][] = [['ID', 'NAME', 'TYPE', 'STATUS']];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const model = m as Record<string, unknown>;
    const status: string[] = [];
    if (model.current === true) status.push('current');
    if (model.recommended === true) status.push('recommended');
    if (model.broken === true) status.push('broken');
    rows.push([str(model.id), str(model.displayName), str(model.mediaType), status.join(', ')]);
  }
  return rows;
}

export async function modelsCommand(ctx: Context, options: ModelsOptions): Promise<void> {
  await withSession(ctx, async (session) => {
    const args: Record<string, unknown> = {};
    if (options.type) args.type = options.type;
    if (options.q) args.q = options.q;
    if (options.limit !== undefined) args.limit = options.limit;
    if (options.offset !== undefined) args.offset = options.offset;
    if (options.all) args.includeAll = true;
    const outcome = await session.callTool('list_models', args);
    if (isFailed(outcome)) throw failureToError(outcome.payload);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json(outcome.payload);
      return;
    }
    const models = Array.isArray(outcome.payload.models) ? outcome.payload.models : [];
    if (models.length === 0) {
      out.line('No models found.');
      return;
    }
    for (const row of renderTable(modelRows(models), [60, 36, 6])) out.line(row);
    const next = outcome.payload.nextOffset;
    if (outcome.payload.truncated === true && typeof next === 'number') {
      const total = typeof outcome.payload.modelCount === 'number' ? ` of ${outcome.payload.modelCount}` : '';
      out.note(`Showing ${models.length}${total}. Next page: --offset ${next}`);
    }
  });
}

/** Lines describing one input field; `typeLabel` replaces the schema type (e.g. "file (image)"). */
export function describeField(name: string, field: Record<string, unknown>, required: boolean, typeLabel?: string): string[] {
  const type = typeLabel ?? (Array.isArray(field.type) ? field.type.join('|') : str(field.type) || 'any');
  const bits = [type];
  if (required) bits.push('required');
  if (field.default !== undefined) bits.push(`default ${JSON.stringify(field.default)}`);
  const head = `  ${name}${required ? '*' : ''}  ${bits.join(', ')}`;
  const lines = [head];
  if (Array.isArray(field.enum) && field.enum.length > 0) {
    lines.push(`      one of: ${field.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  const description = str(field.description).replace(/\s+/g, ' ').trim();
  if (description) lines.push(`      ${description.length > 160 ? `${description.slice(0, 159)}…` : description}`);
  return lines;
}

export async function modelCommand(ctx: Context, modelId: string): Promise<void> {
  await withSession(ctx, async (session) => {
    const outcome = await session.callTool('get_model_schema', { modelId });
    if (isFailed(outcome)) throw failureToError(outcome.payload);
    const { out } = ctx;
    if (out.jsonMode) {
      out.json(outcome.payload);
      return;
    }
    const schema = schemaFromPayload(outcome.payload);
    const names = fieldNames(schema);
    out.line(out.out.bold(modelId));
    if (names.length === 0) {
      out.line('This model lists no input fields.');
      return;
    }
    out.line('Input fields (* = required):');
    const required = new Set(schema.required);
    for (const name of names) {
      for (const line of describeField(name, schema.properties[name] ?? {}, required.has(name))) out.line(line);
    }
    out.line('');
    out.line(out.out.dim(`Set a field with --set <field>=<value> together with --model ${modelId}.`));
  });
}
