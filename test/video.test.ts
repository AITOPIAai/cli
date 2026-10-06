import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors.js';
import {
  ASPECT_FIELDS,
  applySetFields,
  coerceValue,
  mapFlag,
  modelsFromPayload,
  pickModel,
  schemaFromPayload,
} from '../src/schema.js';
import { parseSetPairs } from '../src/args.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/video-schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const schema = schemaFromPayload(fixture);
const modelId = 'acme/video-pro';

describe('schema fields and --set', () => {
  it('reads the schema fields', () => {
    expect(Object.keys(schema.properties)).toContain('start_image_url');
    expect(schema.required).toEqual(['prompt']);
  });

  it('keeps a JSON-parsed number as a string for string fields', () => {
    const input = applySetFields(modelId, schema, { prompt: 'x' }, parseSetPairs(['duration=10']));
    expect(input.duration).toBe('10');
  });

  it('lists the schema fields when a --set field is unknown', () => {
    const error = (() => {
      try {
        applySetFields(modelId, schema, { prompt: 'x' }, { resolution: '1080p' });
      } catch (e) {
        return e as UsageError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(UsageError);
    expect(error?.message).toContain('"resolution"');
    expect(error?.hint).toContain('start_image_url');
    expect(error?.hint).toContain('negative_prompt');
  });

  it('passes fields through when the schema lists none', () => {
    const empty = schemaFromPayload({});
    expect(applySetFields(modelId, empty, { prompt: 'p' }, { anything: 1 })).toEqual({ prompt: 'p', anything: 1 });
  });

});

describe('coerceValue', () => {
  it('converts between strings and numbers per type', () => {
    expect(coerceValue({ type: 'integer' }, '5')).toBe(5);
    expect(coerceValue({ type: 'integer' }, 'five')).toBe('five');
    expect(coerceValue({ type: ['string', 'null'] }, 5)).toBe('5');
    expect(coerceValue({ type: 'boolean' }, 'TRUE')).toBe(true);
    expect(coerceValue(undefined, 5)).toBe(5);
  });
});

describe('model choice', () => {
  // Server order: most used first, then current generation. `recommended` marks old models.
  const videos = modelsFromPayload({
    models: [
      { id: 'old/t2v', capabilities: ['text-to-video'], recommended: true, mediaType: 'video' },
      { id: 'broken/i2v', capabilities: ['image-to-video'], current: true, broken: true, mediaType: 'video' },
      { id: 'new/t2v', capabilities: ['text-to-video'], current: true, mediaType: 'video' },
      { id: 'new/i2v', capabilities: ['image-to-video', 'text-to-video'], current: true, mediaType: 'video' },
    ],
  });

  it('prefers a current model in server order and ignores recommended', () => {
    expect(pickModel(videos, 'text-to-video')).toBe('new/t2v');
    expect(pickModel(videos, 'image-to-video')).toBe('new/i2v');
  });

  it('falls back to the first fitting model when none is current', () => {
    const plain = modelsFromPayload({ models: [{ id: 'a', capabilities: ['text-to-video'] }, { id: 'b', capabilities: ['text-to-video'] }] });
    expect(pickModel(plain, 'text-to-video')).toBe('a');
  });

  it('skips non-generating image models (upscalers, face restoration)', () => {
    const images = modelsFromPayload({
      models: [
        { id: 'tencentarc/gfpgan', capabilities: ['face-restoration'], mediaType: 'image' },
        { id: 'google/nano-banana-2', capabilities: ['image-generation'], mediaType: 'image', current: true },
      ],
    });
    expect(pickModel(images, 'image')).toBe('google/nano-banana-2');
    expect(pickModel([], 'audio')).toBeUndefined();
  });

});

describe('mapFlag', () => {
  it("maps --aspect to the model's own field and checks its enum", () => {
    const flux = schemaFromPayload({ schema: { properties: { prompt: {}, image_size: { type: 'string', enum: ['square', 'landscape_16_9'] } } } });
    expect(mapFlag(flux, 'm', '--aspect', ['aspect_ratio', 'image_size'], 'landscape_16_9')).toEqual(['image_size', 'landscape_16_9']);
    expect(mapFlag(flux, 'm', '--aspect', ['aspect_ratio', 'image_size'], '16:9')).toEqual(['image_size', 'landscape_16_9']);
    expect(() => mapFlag(flux, 'm', '--aspect', ['aspect_ratio', 'image_size'], '9:16')).toThrow(/not accepted/);
    const none = schemaFromPayload({ schema: { properties: { prompt: {} } } });
    expect(() => mapFlag(none, 'm', '--aspect', ['aspect_ratio'], '1:1')).toThrow(/does not take --aspect/);
  });
});

describe('aspect presets', () => {
  it('maps a ratio onto a size-preset enum', () => {
    const schema = { properties: { image_size: { type: 'string', enum: ['square_hd', 'square', 'landscape_16_9', 'portrait_16_9'] } } };
    expect(mapFlag(schema as never, 'm', '--aspect', ASPECT_FIELDS, '1:1')).toEqual(['image_size', 'square_hd']);
    expect(mapFlag(schema as never, 'm', '--aspect', ASPECT_FIELDS, '9:16')).toEqual(['image_size', 'portrait_16_9']);
    expect(() => mapFlag(schema as never, 'm', '--aspect', ASPECT_FIELDS, '21:9')).toThrow(/not accepted/);
  });
});
