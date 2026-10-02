import { CliError, UsageError } from './errors.js';

export interface SchemaField {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  items?: SchemaField;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
}

export interface ModelSchema {
  properties: Record<string, SchemaField>;
  required: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** get_model_schema answers {modelId, schema:{properties, required}}; tolerate a bare schema too. */
export function schemaFromPayload(payload: Record<string, unknown>): ModelSchema {
  const schema = isObject(payload.schema) ? payload.schema : payload;
  const properties = isObject(schema.properties) ? (schema.properties as Record<string, SchemaField>) : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [];
  return { properties, required };
}

export function fieldNames(schema: ModelSchema): string[] {
  return Object.keys(schema.properties);
}

export function primaryType(field: SchemaField | undefined): string | undefined {
  if (!field) return undefined;
  if (Array.isArray(field.type)) return field.type.find((t) => t !== 'null');
  return field.type;
}

/** Fits a value to the field's type: "5" → 5 for numbers, 5 → "5" for strings (e.g. string enums). */
export function coerceValue(field: SchemaField | undefined, value: unknown): unknown {
  const type = primaryType(field);
  if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) return String(value);
  if ((type === 'integer' || type === 'number') && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  if (type === 'boolean' && typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (type === 'array' && !Array.isArray(value) && value !== undefined) return [coerceValue(field?.items, value)];
  return value;
}

/** Candidate names for the start image of image-to-video models, most specific first. */
export const IMAGE_FIELD_CANDIDATES = [
  'image_url',
  'start_image_url',
  'first_frame_image',
  'first_frame_url',
  'start_image',
  'first_frame',
  'image',
  'input_image',
  'input_image_url',
  'init_image',
  'reference_image',
  'image_urls',
  'reference_images',
];

export function findImageField(schema: ModelSchema): string | undefined {
  const names = new Set(fieldNames(schema));
  return IMAGE_FIELD_CANDIDATES.find((name) => names.has(name));
}

function unknownFieldError(modelId: string, unknown: string[], schema: ModelSchema): UsageError {
  const list = fieldNames(schema).join(', ') || '(none)';
  const label = unknown.length === 1 ? 'field' : 'fields';
  return new UsageError(`Model ${modelId} has no ${label} ${unknown.map((u) => `"${u}"`).join(', ')}.`, `Its fields are: ${list}`);
}

/** Checks --set keys against the schema and fits their values. */
export function applySetFields(
  modelId: string,
  schema: ModelSchema,
  input: Record<string, unknown>,
  sets: Record<string, unknown>,
): Record<string, unknown> {
  const names = new Set(fieldNames(schema));
  if (names.size === 0) return { ...input, ...sets };
  const unknown = Object.keys(sets).filter((k) => !names.has(k));
  if (unknown.length > 0) throw unknownFieldError(modelId, unknown, schema);
  const out = { ...input };
  for (const [key, value] of Object.entries(sets)) out[key] = coerceValue(schema.properties[key], value);
  return out;
}

/** Field names that take an aspect ratio / a duration, most common first. */
export const ASPECT_FIELDS = ['aspect_ratio', 'image_size', 'size', 'aspect', 'ratio', 'resolution'];
export const DURATION_FIELDS = ['duration', 'duration_seconds', 'seconds', 'length', 'video_length'];

/**
 * Puts a flag's value into the schema field that takes it (e.g. --aspect →
 * aspect_ratio or image_size), fitted to its type and checked against its
 * enum. Errors list the model's fields when none fits. A schema listing no
 * fields cannot be checked, so the first candidate name is used.
 */
export function mapFlag(
  schema: ModelSchema,
  modelId: string,
  flag: string,
  candidates: string[],
  raw: string,
): [string, unknown] {
  const names = fieldNames(schema);
  if (names.length === 0) return [candidates[0] as string, coerceValue(undefined, raw)];
  const field = candidates.find((c) => names.includes(c));
  if (!field) {
    throw new UsageError(`Model ${modelId} does not take ${flag}.`, `Its fields are: ${names.join(', ')}. Use --set <field>=<value>.`);
  }
  const spec = schema.properties[field];
  let value = coerceValue(spec ?? { type: 'number' }, raw);
  if (spec && Array.isArray(spec.enum) && !spec.enum.some((e) => e === value)) {
    const named = namedAspect(raw, spec.enum);
    if (named !== undefined) value = named;
  }
  if (spec && Array.isArray(spec.enum) && spec.enum.length > 0 && !spec.enum.some((e) => e === value)) {
    throw new UsageError(
      `${flag} ${raw} is not accepted by ${modelId} (field "${field}").`,
      `Allowed: ${spec.enum.map((e) => String(e)).join(', ')}`,
    );
  }
  return [field, value];
}

// Models that take a size preset (image_size: square_hd, landscape_16_9 …)
// instead of a ratio: map the common ratios onto those names.
const ASPECT_PRESETS: Record<string, string[]> = {
  '1:1': ['square_hd', 'square'],
  '16:9': ['landscape_16_9'],
  '9:16': ['portrait_16_9', 'portrait_9_16'],
  '4:3': ['landscape_4_3'],
  '3:4': ['portrait_4_3', 'portrait_3_4'],
};

export function namedAspect(raw: string, allowed: unknown[]): string | undefined {
  const names = ASPECT_PRESETS[raw.trim()];
  return names?.find((n) => allowed.includes(n));
}

export interface VideoInputOptions {
  modelId: string;
  prompt: string;
  duration?: string;
  aspect?: string;
  imageUrl?: string;
  sets?: Record<string, unknown>;
}

/**
 * Maps the video command's flags onto a model's input fields:
 * prompt → prompt, --duration → duration, --aspect → aspect_ratio, --image →
 * the start-image field, --set → any field.
 */
export function buildVideoInput(schema: ModelSchema, options: VideoInputOptions): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (options.prompt) input.prompt = options.prompt;
  if (options.duration !== undefined) {
    const [field, value] = mapFlag(schema, options.modelId, '--duration', DURATION_FIELDS, options.duration);
    input[field] = value;
  }
  if (options.aspect !== undefined) {
    const [field, value] = mapFlag(schema, options.modelId, '--aspect', ASPECT_FIELDS, options.aspect);
    input[field] = value;
  }
  if (options.imageUrl !== undefined) {
    const field = findImageField(schema);
    if (!field) {
      throw new UsageError(
        `Model ${options.modelId} has no start-image field, so --image cannot be used.`,
        `Its fields are: ${fieldNames(schema).join(', ') || '(none)'}. Pass one with --set <field>=<url>, or pick an image-to-video model.`,
      );
    }
    input[field] = coerceValue(schema.properties[field], options.imageUrl);
  }
  return applySetFields(options.modelId, schema, input, options.sets ?? {});
}

export interface ModelSummary {
  id: string;
  capabilities: string[];
  current: boolean;
  broken: boolean;
  mediaType?: string;
}

export function modelsFromPayload(payload: Record<string, unknown>): ModelSummary[] {
  const list = Array.isArray(payload.models) ? payload.models : [];
  return list.filter(isObject).flatMap((m) =>
    typeof m.id === 'string'
      ? [
          {
            id: m.id,
            capabilities: Array.isArray(m.capabilities) ? m.capabilities.filter((c): c is string => typeof c === 'string') : [],
            current: m.current === true,
            broken: m.broken === true,
            mediaType: typeof m.mediaType === 'string' ? m.mediaType : undefined,
          },
        ]
      : [],
  );
}

export type GenerationKind = 'image' | 'audio' | 'text-to-video' | 'image-to-video';

/** Capabilities that mean "makes new media from a prompt" (matches the server's list). */
const GENERATING: Record<GenerationKind, string[]> = {
  image: ['image-generation', 'text-to-image'],
  audio: ['text-to-speech', 'music-generation', 'sound-effects', 'audio-generation'],
  'text-to-video': ['text-to-video', 'video-generation'],
  'image-to-video': ['image-to-video'],
};

const MEDIA_TYPE: Record<GenerationKind, string> = {
  image: 'image',
  audio: 'audio',
  'text-to-video': 'video',
  'image-to-video': 'video',
};

/**
 * The model used when --model is not given. The server's order is kept (most
 * used and newest first); broken models and non-generators (upscalers, face
 * restoration) are skipped; a `current` model wins. `recommended` is ignored:
 * the server marks older models with it. Models listing no capabilities are
 * accepted. Returns undefined when nothing fits.
 */
export function pickModel(models: ModelSummary[], kind: GenerationKind): string | undefined {
  const wanted = new Set(GENERATING[kind]);
  const type = MEDIA_TYPE[kind];
  const candidates = models.filter(
    (m) =>
      !m.broken &&
      (m.mediaType === undefined || m.mediaType === type) &&
      (m.capabilities.length === 0 || m.capabilities.some((c) => wanted.has(c.toLowerCase()))),
  );
  const pick = candidates.find((m) => m.current) ?? candidates[0];
  return pick?.id;
}

/** pickModel for video; fails clearly when nothing fits. */
export function pickVideoModel(models: ModelSummary[], hasImage: boolean): string {
  const kind: GenerationKind = hasImage ? 'image-to-video' : 'text-to-video';
  const id = pickModel(models, kind);
  if (!id) {
    throw new CliError(`No ${kind} model is available right now.`, 1, {
      code: 'NO_MODEL',
      hint: 'List models with `aitopia models --type video` and pass one with --model.',
    });
  }
  return id;
}
