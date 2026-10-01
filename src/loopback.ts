import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CliError, EXIT } from './errors.js';

export const CALLBACK_PATH = '/callback';
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface LoopbackOptions {
  expectedState: string;
  /** Port to try first (the one the stored client was registered with). Falls back to a random port. */
  preferredPort?: number;
  timeoutMs?: number;
}

export interface Loopback {
  port: number;
  redirectUrl: string;
  /** Resolves with the authorization code of the first callback whose state matches. */
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

export function randomState(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time string comparison (hashing first hides the length). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function page(title: string, body: string, ok: boolean): string {
  const accent = ok ? '#15803d' : '#b91c1c';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - AITOPIA CLI</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #f6f6f7; color: #18181b; }
  main { max-width: 28rem; padding: 2.5rem; background: #fff; border-radius: 12px;
         box-shadow: 0 1px 3px rgba(0,0,0,.08); text-align: center; }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; color: ${accent}; }
  p { margin: 0; color: #52525b; }
  @media (prefers-color-scheme: dark) {
    body { background: #18181b; color: #f4f4f5; }
    main { background: #27272a; box-shadow: none; }
    p { color: #a1a1aa; }
  }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
</main>
</body>
</html>
`;
}

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
};

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, Connection: 'close' });
  res.end(html);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * One-shot HTTP server on 127.0.0.1 for the OAuth redirect (RFC 8252).
 * Only GET /callback with the expected state is accepted; anything else gets
 * a 400 and the server keeps waiting. It closes after the first valid callback
 * or when the timeout passes.
 */
export async function startLoopback(options: LoopbackOptions): Promise<Loopback> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
  let outcome: { code?: string; error?: Error } | undefined;
  let done = false;
  let closing: Promise<void> | undefined;

  // `res` is the answer to the browser: the server closes once it has been sent.
  const finish = (result: { code?: string; error?: Error }, res?: ServerResponse) => {
    if (done) return;
    done = true;
    outcome = result;
    clearTimeout(timer);
    if (settle) {
      if (result.code !== undefined) settle.resolve(result.code);
      else settle.reject(result.error ?? new Error('Sign-in failed.'));
    }
    if (res && !res.writableFinished) res.once('finish', () => void close());
    else void close();
  };

  const timer = setTimeout(() => {
    finish({
      error: new CliError('Sign-in timed out after 5 minutes.', EXIT.AUTH, {
        code: 'LOGIN_TIMEOUT',
        hint: 'Run `aitopia login` again.',
      }),
    });
  }, timeoutMs);
  timer.unref();

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (done) {
      send(res, 400, page('Sign-in already handled', 'You can close this tab.', false));
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      send(res, 400, page('Bad request', 'This address is not part of the sign-in.', false));
      return;
    }
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      send(res, 400, page('Bad request', 'This address is not part of the sign-in.', false));
      return;
    }
    const state = url.searchParams.get('state') ?? '';
    if (!safeEqual(state, options.expectedState)) {
      send(res, 400, page('Sign-in link not recognized', 'Start again from the terminal with: aitopia login', false));
      return;
    }
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      const description = url.searchParams.get('error_description') ?? oauthError;
      send(res, 400, page('Sign-in was not completed', description, false));
      finish({ error: new CliError(`Sign-in was not completed: ${description}`, EXIT.AUTH, { code: 'LOGIN_FAILED' }) }, res);
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      send(res, 400, page('Bad request', 'The sign-in answer had no code.', false));
      return;
    }
    send(res, 200, page('Signed in to AITOPIA', 'You can close this tab and return to the terminal.', true));
    finish({ code }, res);
  };

  const server = createServer(handler);
  server.keepAliveTimeout = 1000;
  server.requestTimeout = 10_000;

  let port: number;
  try {
    port = options.preferredPort ? await listen(server, options.preferredPort) : await listen(server, 0);
  } catch (error) {
    if (!options.preferredPort) throw error;
    port = await listen(server, 0);
  }

  function close(): Promise<void> {
    if (!closing) {
      closing = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    }
    return closing;
  }

  const codePromise = new Promise<string>((resolve, reject) => {
    if (outcome) {
      if (outcome.code !== undefined) resolve(outcome.code);
      else reject(outcome.error);
      return;
    }
    settle = { resolve, reject };
  });
  // Avoid an unhandled rejection when nobody waits (e.g. the flow failed earlier).
  codePromise.catch(() => undefined);

  return {
    port,
    redirectUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    waitForCode: () => codePromise,
    close: async () => {
      clearTimeout(timer);
      done = true;
      const closed = close();
      server.closeAllConnections();
      await closed;
    },
  };
}
