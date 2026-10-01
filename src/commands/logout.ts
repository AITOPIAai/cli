import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Context } from '../context.js';
import { safeHost } from '../errors.js';

const REVOKE_TIMEOUT_MS = 10_000;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The server's revocation endpoint, from its metadata; `<issuer>/revoke` as a
 * fallback. Tokens are only ever sent to the issuer's own origin.
 */
export async function revocationEndpoint(serverUrl: string): Promise<string | undefined> {
  let issuer = new URL('/', serverUrl).toString();
  try {
    const resource = await discoverOAuthProtectedResourceMetadata(serverUrl);
    if (resource.authorization_servers?.[0]) issuer = resource.authorization_servers[0];
  } catch {
    // use the server origin
  }
  try {
    const metadata = await discoverAuthorizationServerMetadata(issuer);
    const endpoint = (metadata as { revocation_endpoint?: unknown } | undefined)?.revocation_endpoint;
    if (typeof endpoint === 'string' && endpoint) return sameOrigin(endpoint, issuer) ? endpoint : undefined;
  } catch {
    // fall through
  }
  const fallback = new URL('revoke', issuer.endsWith('/') ? issuer : `${issuer}/`).toString();
  return sameOrigin(fallback, issuer) ? fallback : undefined;
}

async function revoke(endpoint: string, token: string, hint: string, clientId: string): Promise<boolean> {
  const body = new URLSearchParams({ token, token_type_hint: hint, client_id: clientId });
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

export async function logoutCommand(ctx: Context): Promise<void> {
  const { out, store, serverUrl } = ctx;
  const entry = store.get(serverUrl);
  const host = safeHost(serverUrl);
  if (!entry) {
    if (out.jsonMode) out.json({ status: 'signed_out', server: serverUrl, wasSignedIn: false });
    else out.line(`Not signed in to ${host}.`);
    return;
  }

  let revoked = true;
  const tokens = entry.tokens;
  const clientId = entry.client?.client_id;
  if (tokens && clientId) {
    const endpoint = await revocationEndpoint(serverUrl);
    if (endpoint) {
      ctx.log?.(`revoking at ${endpoint}`);
      const results = await Promise.all([
        tokens.refresh_token ? revoke(endpoint, tokens.refresh_token, 'refresh_token', clientId) : Promise.resolve(true),
        revoke(endpoint, tokens.access_token, 'access_token', clientId),
      ]);
      revoked = results.every(Boolean);
    } else {
      revoked = false;
    }
  }
  store.remove(serverUrl);

  if (out.jsonMode) {
    out.json({ status: 'signed_out', server: serverUrl, wasSignedIn: true, revoked });
    return;
  }
  out.line(`Signed out of ${host}.`);
  if (!revoked) out.note('The server could not be reached to revoke the session; the local sign-in was removed anyway.');
}
