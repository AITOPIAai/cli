import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { escapeHtml, safeEqual, startLoopback, type Loopback } from '../src/loopback.js';

function get(port: number, path: string, method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('loopback callback server', () => {
  let loop: Loopback | undefined;
  afterEach(async () => {
    await loop?.close();
    loop = undefined;
  });

  it('listens on 127.0.0.1 with a /callback redirect URL', async () => {
    loop = await startLoopback({ expectedState: 'S' });
    expect(loop.redirectUrl).toBe(`http://127.0.0.1:${loop.port}/callback`);
  });

  it('rejects a wrong state with 400 and keeps waiting; the right state resolves the code', async () => {
    loop = await startLoopback({ expectedState: 'expected-state' });
    const port = loop.port;
    const code = loop.waitForCode();

    const wrong = await get(port, '/callback?code=evil&state=other');
    expect(wrong.status).toBe(400);
    const missing = await get(port, '/callback?code=evil');
    expect(missing.status).toBe(400);

    const ok = await get(port, '/callback?code=the-code&state=expected-state');
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('Signed in to AITOPIA');
    expect(ok.headers['content-security-policy']).toContain("default-src 'none'");
    await expect(code).resolves.toBe('the-code');
  });

  it('rejects other paths and methods with 400', async () => {
    loop = await startLoopback({ expectedState: 's' });
    expect((await get(loop.port, '/')).status).toBe(400);
    expect((await get(loop.port, '/favicon.ico')).status).toBe(400);
    expect((await get(loop.port, '/callback?code=c&state=s', 'POST')).status).toBe(400);
  });

  it('closes after one valid callback', async () => {
    loop = await startLoopback({ expectedState: 's' });
    const port = loop.port;
    await get(port, '/callback?code=c&state=s');
    await expect(loop.waitForCode()).resolves.toBe('c');
    await new Promise((r) => setTimeout(r, 50));
    await expect(get(port, '/callback?code=c2&state=s')).rejects.toThrow();
  });

  it('fails when the provider returns an error, escaping the reflected text', async () => {
    loop = await startLoopback({ expectedState: 's' });
    const code = loop.waitForCode();
    const res = await get(loop.port, `/callback?state=s&error=access_denied&error_description=${encodeURIComponent('<script>x</script>')}`);
    expect(res.status).toBe(400);
    expect(res.body).not.toContain('<script>');
    expect(res.body).toContain('&lt;script&gt;');
    await expect(code).rejects.toMatchObject({ exitCode: 3 });
  });

  it('times out', async () => {
    loop = await startLoopback({ expectedState: 's', timeoutMs: 30 });
    await expect(loop.waitForCode()).rejects.toThrow(/timed out/);
  });

  it('falls back to a random port when the preferred one is taken', async () => {
    const first = await startLoopback({ expectedState: 'a' });
    try {
      loop = await startLoopback({ expectedState: 'b', preferredPort: first.port });
      expect(loop.port).not.toBe(first.port);
    } finally {
      await first.close();
    }
  });
});

describe('helpers', () => {
  it('compares states exactly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
