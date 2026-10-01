import { BUY_CREDITS_URL } from './errors.js';

export type Payload = Record<string, unknown>;

export interface ResourceLink {
  uri: string;
  name: string;
  title?: string;
  mimeType?: string;
}

/** A tool result reduced to what the CLI needs. */
export interface ToolOutcome {
  payload: Payload;
  isError: boolean;
  links: ResourceLink[];
}

export interface RawToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
  [key: string]: unknown;
}

export const OPEN_IN_AITOPIA = 'Open in AITOPIA';
export const BUY_CREDITS = 'Buy AITOPIA credits';

const CREDIT_PATTERN = /insufficient (?:credits|balance)|not enough (?:aitopia )?credits/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(text: string): Payload | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a tool result: the payload is JSON in content[0].text, else
 * structuredContent; a plain-text error becomes {status:'failed', code, error}.
 * resource_link blocks are collected so links can be found by name.
 */
export function parseToolResult(result: RawToolResult): ToolOutcome {
  const blocks = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const isError = result.isError === true;
  const links: ResourceLink[] = [];
  const texts: string[] = [];
  for (const block of blocks) {
    if (!isObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    if (block.type === 'resource_link' && typeof block.uri === 'string') {
      links.push({
        uri: block.uri,
        name: typeof block.name === 'string' ? block.name : '',
        title: typeof block.title === 'string' ? block.title : undefined,
        mimeType: typeof block.mimeType === 'string' ? block.mimeType : undefined,
      });
    }
  }

  const first = blocks[0];
  let payload: Payload | undefined =
    isObject(first) && first.type === 'text' && typeof first.text === 'string' ? parseObject(first.text) : undefined;
  if (!payload && isObject(result.structuredContent)) payload = { ...result.structuredContent };

  if (!payload) {
    const text = texts.join('\n').trim();
    if (isError) {
      payload = {
        status: 'failed',
        code: CREDIT_PATTERN.test(text) ? 'INSUFFICIENT_CREDITS' : 'FAILED',
        error: text || 'The tool failed.',
      };
    } else {
      payload = text ? { status: 'completed', text } : { status: 'completed' };
    }
  }

  if (isError && payload.status !== 'failed') payload = { ...payload, status: 'failed' };
  if (isError && typeof payload.code !== 'string') {
    const text = typeof payload.error === 'string' ? payload.error : texts.join(' ');
    payload = { ...payload, code: CREDIT_PATTERN.test(text) ? 'INSUFFICIENT_CREDITS' : 'FAILED' };
  }
  return { payload, isError, links };
}

export function statusOf(outcome: ToolOutcome): string {
  const status = outcome.payload.status;
  if (outcome.isError) return 'failed';
  return typeof status === 'string' ? status : 'completed';
}

export function isFailed(outcome: ToolOutcome): boolean {
  return outcome.isError || outcome.payload.status === 'failed';
}

function linkNamed(outcome: ToolOutcome, name: string): string | undefined {
  const lower = name.toLowerCase();
  return outcome.links.find((l) => l.name.toLowerCase() === lower || l.title?.toLowerCase() === lower)?.uri;
}

export function openInAitopiaUrl(outcome: ToolOutcome): string | undefined {
  const direct = outcome.payload.openInAitopia;
  if (typeof direct === 'string' && direct) return direct;
  // Failures carry tool facts under details (the server's normalizeFailure).
  const details = outcome.payload.details;
  const nested = isObject(details) ? details.openInAitopia : undefined;
  if (typeof nested === 'string' && nested) return nested;
  return linkNamed(outcome, OPEN_IN_AITOPIA);
}

export function buyCreditsUrl(outcome: ToolOutcome): string {
  return linkNamed(outcome, BUY_CREDITS) ?? BUY_CREDITS_URL;
}

export interface AssetRef {
  url: string;
  name?: string;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function assetName(item: Record<string, unknown>): string | undefined {
  return typeof item.assetName === 'string' && item.assetName.trim() ? item.assetName.trim() : undefined;
}

/** How deep `output` is searched for file URLs, and how many are taken at most. */
const OUTPUT_SEARCH_DEPTH = 6;
const OUTPUT_MAX_URLS = 20;

/** http(s) URLs anywhere in a value (arrays and objects, bounded depth), in order. */
export function urlsIn(value: unknown, depth = OUTPUT_SEARCH_DEPTH, found: string[] = []): string[] {
  if (found.length >= OUTPUT_MAX_URLS || depth < 0) return found;
  if (isHttpUrl(value)) {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) urlsIn(item, depth - 1, found);
  } else if (isObject(value)) {
    for (const item of Object.values(value)) urlsIn(item, depth - 1, found);
  }
  return found;
}

/**
 * The files a completed result produced, in order and without duplicates:
 * `assets[]`, then `assetUrl`, then URLs found in `output`, then resource_link
 * blocks that are not the AITOPIA / credits pages.
 */
export function assetsOf(outcome: ToolOutcome): AssetRef[] {
  const out: AssetRef[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, name?: string) => {
    if (!isHttpUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push(name ? { url, name } : { url });
  };
  const p = outcome.payload;
  if (Array.isArray(p.assets)) {
    for (const item of p.assets) if (isObject(item)) add(item.assetUrl, assetName(item));
  }
  add(p.assetUrl, assetName(p));
  if (out.length === 0) {
    const urls = urlsIn(p.output);
    for (const url of urls) add(url, urls.length === 1 ? assetName(p) : undefined);
  }
  if (out.length === 0) {
    const skip = new Set([OPEN_IN_AITOPIA.toLowerCase(), BUY_CREDITS.toLowerCase()]);
    for (const link of outcome.links) {
      if (skip.has(link.name.toLowerCase()) || link.mimeType === 'text/html') continue;
      add(link.uri, link.name || undefined);
    }
  }
  return out;
}
