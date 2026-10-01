import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { isSafeBrowserUrl, LoginProvider, openBrowser, registeredLoopbackPort } from '../auth.js';
import type { Context } from '../context.js';
import { CliError, EXIT, safeHost, toCliError } from '../errors.js';
import { randomState, startLoopback } from '../loopback.js';
import { createClient, createTransport, sessionFromClient } from '../mcp.js';
import { creditsLine } from './credits.js';

export interface LoginOptions {
  browser?: boolean;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof UnauthorizedError || (error as { name?: unknown } | null)?.name === 'UnauthorizedError';
}

export async function loginCommand(ctx: Context, options: LoginOptions): Promise<void> {
  const { out, store, serverUrl } = ctx;
  const host = safeHost(serverUrl);
  const state = randomState();
  const loopback = await startLoopback({
    expectedState: state,
    preferredPort: registeredLoopbackPort(store.get(serverUrl)?.client),
  });
  out.debug(`listening on ${loopback.redirectUrl}`);

  const provider = new LoginProvider(store, serverUrl, loopback.redirectUrl, state, async (url) => {
    out.note(
      options.browser === false
        ? 'Open this link in a browser on this computer to sign in to AITOPIA:'
        : 'Sign in to AITOPIA in your browser. If it does not open, visit:',
    );
    out.note('');
    out.note(`  ${url.toString()}`);
    out.note('');
    if (!isSafeBrowserUrl(url.toString())) {
      out.warn('The sign-in link is not https, so it was not opened. Check the server URL before using it.');
    } else if (options.browser !== false) {
      const opened = await openBrowser(url.toString());
      if (!opened) out.note('Could not open a browser. Open the link above to continue.');
    }
    out.note(`Waiting for sign-in on port ${loopback.port} (up to 5 minutes)...`);
  });

  let client: Client = createClient();
  try {
    let transport = createTransport({ serverUrl, provider, log: ctx.log });
    try {
      await client.connect(transport);
    } catch (error) {
      if (!isUnauthorized(error) || !provider.authorizationStarted) throw toCliError(error, serverUrl);
      const code = await loopback.waitForCode();
      await transport.finishAuth(code);
      await client.close().catch(() => undefined);
      client = createClient();
      transport = createTransport({ serverUrl, provider, log: ctx.log });
      await client.connect(transport);
    }
    if (!provider.tokens()) {
      throw new CliError(`${host} did not ask for a sign-in, so there is nothing to save.`, EXIT.FAILED);
    }

    // Confirm the session with a free read.
    const session = sessionFromClient(client, serverUrl);
    const balance = await session.callTool('get_credit_balance', {}).catch(() => undefined);
    if (out.jsonMode) {
      out.json({ status: 'signed_in', server: serverUrl, ...(balance && !balance.isError ? { credits: balance.payload } : {}) });
      return;
    }
    out.line(`${out.out.green('Signed in')} to ${host}.`);
    if (balance && !balance.isError) out.line(creditsLine(balance.payload));
  } catch (error) {
    throw toCliError(error, serverUrl);
  } finally {
    await client.close().catch(() => undefined);
    await loopback.close();
  }
}
