import { describe, expect, it } from 'vitest';
import { assetsOf, buyCreditsUrl, isFailed, openInAitopiaUrl, parseToolResult, statusOf } from '../src/envelope.js';

const text = (value: unknown) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });

describe('parseToolResult', () => {
  it('reads the JSON payload from content[0].text', () => {
    const outcome = parseToolResult({
      content: [text({ status: 'completed', assetUrl: 'https://cdn.aitopia.ai/a/fox.png', assetName: 'fox' })],
    });
    expect(outcome.isError).toBe(false);
    expect(statusOf(outcome)).toBe('completed');
    expect(assetsOf(outcome)).toEqual([{ url: 'https://cdn.aitopia.ai/a/fox.png', name: 'fox' }]);
  });

  it('falls back to structuredContent when the text is not JSON', () => {
    const outcome = parseToolResult({
      isError: true,
      content: [text('Something broke')],
      structuredContent: { status: 'failed', code: 'RATE_LIMIT', error: 'Slow down', retryAfterSeconds: 30 },
    });
    expect(isFailed(outcome)).toBe(true);
    expect(outcome.payload.code).toBe('RATE_LIMIT');
  });

  it('turns a plain-text error into a failure, detecting credit errors', () => {
    const outcome = parseToolResult({ isError: true, content: [text('Insufficient credits for this model')] });
    expect(outcome.payload).toMatchObject({ status: 'failed', code: 'INSUFFICIENT_CREDITS' });
  });

  it('marks isError results as failed even if the payload says otherwise', () => {
    const outcome = parseToolResult({ isError: true, content: [text({ error: 'nope' })] });
    expect(outcome.payload.status).toBe('failed');
    expect(outcome.payload.code).toBe('FAILED');
  });

  it('keeps non-JSON success text', () => {
    const outcome = parseToolResult({ content: [text('hello')] });
    expect(outcome.payload).toEqual({ status: 'completed', text: 'hello' });
  });

  it('collects resource links and finds them by name', () => {
    const outcome = parseToolResult({
      isError: true,
      content: [
        text({ status: 'failed', code: 'INSUFFICIENT_CREDITS', error: 'Not enough credits' }),
        { type: 'resource_link', uri: 'https://aitopia.ai/pricing?x=1', name: 'Buy AITOPIA credits', mimeType: 'text/html' },
      ],
    });
    expect(buyCreditsUrl(outcome)).toBe('https://aitopia.ai/pricing?x=1');
    expect(buyCreditsUrl(parseToolResult({ content: [] }))).toBe('https://aitopia.ai/pricing');
  });

  it('prefers payload.openInAitopia, then the "Open in AITOPIA" link', () => {
    const withField = parseToolResult({ content: [text({ status: 'completed', openInAitopia: 'https://aitopia.ai/c/1' })] });
    expect(openInAitopiaUrl(withField)).toBe('https://aitopia.ai/c/1');
    const withLink = parseToolResult({
      content: [text({ status: 'completed' }), { type: 'resource_link', uri: 'https://aitopia.ai/c/2', name: 'Open in AITOPIA' }],
    });
    expect(openInAitopiaUrl(withLink)).toBe('https://aitopia.ai/c/2');
  });
});

describe('assetsOf', () => {
  it('lists batch assets in order without duplicates', () => {
    const outcome = parseToolResult({
      content: [
        text({
          status: 'completed',
          assetUrl: 'https://cdn.aitopia.ai/1.png',
          assets: [
            { assetUrl: 'https://cdn.aitopia.ai/1.png', assetName: 'one' },
            { assetUrl: 'https://cdn.aitopia.ai/2.png', assetName: 'two' },
          ],
        }),
      ],
    });
    expect(assetsOf(outcome).map((a) => a.url)).toEqual(['https://cdn.aitopia.ai/1.png', 'https://cdn.aitopia.ai/2.png']);
  });

  it('uses URL-valued output when assetUrl is null', () => {
    const outcome = parseToolResult({
      content: [text({ status: 'completed', assetUrl: null, output: ['https://cdn.aitopia.ai/v.mp4', 42] })],
    });
    expect(assetsOf(outcome)).toEqual([{ url: 'https://cdn.aitopia.ai/v.mp4' }]);
  });

  it('falls back to file resource_links, skipping the AITOPIA and credits pages', () => {
    const outcome = parseToolResult({
      content: [
        text({ status: 'completed' }),
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        { type: 'resource_link', uri: 'https://cdn.aitopia.ai/x.mp4', name: 'clip', mimeType: 'video/mp4' },
        { type: 'resource_link', uri: 'https://aitopia.ai/c/9', name: 'Open in AITOPIA', mimeType: 'text/html' },
        { type: 'resource_link', uri: 'https://aitopia.ai/pricing', name: 'Buy AITOPIA credits', mimeType: 'text/html' },
      ],
    });
    expect(assetsOf(outcome)).toEqual([{ url: 'https://cdn.aitopia.ai/x.mp4', name: 'clip' }]);
  });

  it('ignores non-http URLs', () => {
    const outcome = parseToolResult({ content: [text({ status: 'completed', assetUrl: 'file:///etc/passwd' })] });
    expect(assetsOf(outcome)).toEqual([]);
  });
});

describe('assetsOf never downloads AITOPIA web pages', () => {
  it('skips creations / chat page links and keeps CDN files', async () => {
    const { assetsOf } = await import('../src/envelope.js');
    const outcome = {
      isError: false,
      payload: { status: 'completed', creationUrl: 'https://aitopia.ai/creations?runId=x', output: { link: 'https://scotty.aitopia.ai/chat/1' } },
      links: [{ uri: 'https://aitopia.ai/creations?runId=x', name: 'Creation' }],
    } as never;
    expect(assetsOf(outcome)).toEqual([]);
    const withFile = { isError: false, payload: { status: 'completed', assetUrl: 'https://cdn.aitopia.ai/f/x.png' }, links: [] } as never;
    expect(assetsOf(withFile).map((a: { url: string }) => a.url)).toEqual(['https://cdn.aitopia.ai/f/x.png']);
  });
});
