import { spawn } from 'node:child_process';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CredentialStore } from './credentials.js';
import { NotSignedInError } from './errors.js';
import { isLoopbackHost } from './config.js';

export const CLIENT_NAME = 'AITOPIA CLI';
export const OAUTH_SCOPE = 'mcp';

export function clientMetadataFor(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: CLIENT_NAME,
    client_uri: 'https://github.com/AITOPIAai/cli',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: OAUTH_SCOPE,
  };
}

function redirectUrisOf(client: OAuthClientInformationMixed | undefined): string[] {
  const uris = (client as { redirect_uris?: unknown } | undefined)?.redirect_uris;
  return Array.isArray(uris) ? uris.filter((u): u is string => typeof u === 'string') : [];
}

/** Port of the loopback redirect the stored client was registered with, if any. */
export function registeredLoopbackPort(client: OAuthClientInformationMixed | undefined): number | undefined {
  for (const uri of redirectUrisOf(client)) {
    try {
      const url = new URL(uri);
      if (url.hostname === '127.0.0.1' && url.port) return Number(url.port);
    } catch {
      // ignore malformed entries
    }
  }
  return undefined;
}

/**
 * Provider for every command except `login`: uses the stored client and tokens,
 * lets the SDK refresh them, and never starts a browser sign-in. When the SDK
 * would need a new sign-in it gets NotSignedInError instead.
 */
export class StoredSessionProvider implements OAuthClientProvider {
  private discovery?: OAuthDiscoveryState;
  /** The refresh token last handed to the SDK (the one a refresh would use). */
  private servedRefreshToken?: string;

  constructor(
    private readonly store: CredentialStore,
    private readonly serverUrl: string,
  ) {}

  get redirectUrl(): string {
    // Only used by the SDK to tell an interactive client from a machine client;
    // this provider never redirects.
    return redirectUrisOf(this.store.get(this.serverUrl)?.client)[0] ?? 'http://127.0.0.1/callback';
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadataFor(this.redirectUrl);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.store.get(this.serverUrl)?.client;
    // Registering a new client means a new sign-in, which only `aitopia login` does.
    if (!client) throw new NotSignedInError(this.hadTokens() ? 'Your session has expired. Run `aitopia login`.' : undefined, 'SESSION_EXPIRED');
    return client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    const stored = this.store.get(this.serverUrl)?.client;
    if (!stored || stored.client_id !== info.client_id) throw new NotSignedInError();
    this.store.update(this.serverUrl, (entry) => ({ ...entry, client: info }));
  }

  tokens(): OAuthTokens | undefined {
    const tokens = this.store.get(this.serverUrl)?.tokens;
    this.servedRefreshToken = tokens?.refresh_token;
    return tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.update(this.serverUrl, (entry) => ({ ...entry, tokens }));
  }

  /**
   * The server rotates refresh tokens, so when two commands refresh at once one
   * of them gets invalid_grant for a token the other already replaced. Before
   * dropping the tokens, re-read the file: if another process stored a new
   * refresh token, keep it (the SDK then retries with it).
   */
  private async refreshedElsewhere(): Promise<boolean> {
    const rejected = this.servedRefreshToken;
    if (!rejected) return false;
    const deadline = Date.now() + this.refreshWaitMs;
    for (;;) {
      const current = this.store.get(this.serverUrl)?.tokens?.refresh_token;
      if (current && current !== rejected) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** How long to wait for a parallel refresh to land before giving up on the session. */
  refreshWaitMs = 2000;

  redirectToAuthorization(): never {
    // A refresh token still stored here means the refresh failed for a reason
    // other than a rejected grant (server or network trouble).
    if (this.store.get(this.serverUrl)?.tokens?.refresh_token) {
      throw new NotSignedInError(
        'Could not renew your session. Try again; if it keeps failing, run `aitopia login`.',
        'SESSION_REFRESH_FAILED',
      );
    }
    throw new NotSignedInError('Your session has expired. Run `aitopia login`.', 'SESSION_EXPIRED');
  }

  saveCodeVerifier(): void {
    // not used: this provider never starts an authorization
  }

  codeVerifier(): string {
    throw new NotSignedInError();
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'discovery') {
      this.discovery = undefined;
      return;
    }
    if (scope === 'verifier') return;
    if (scope === 'tokens' && (await this.refreshedElsewhere())) return;
    const rejected = this.servedRefreshToken;
    this.store.update(this.serverUrl, (entry) => {
      if (scope === 'all') return undefined;
      const next = { ...entry };
      if (scope === 'client') delete next.client;
      // Only drop the tokens that were rejected, never newer ones.
      if (scope === 'tokens' && (!rejected || next.tokens?.refresh_token === rejected)) delete next.tokens;
      return next;
    });
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  private hadTokens(): boolean {
    return Boolean(this.store.get(this.serverUrl)?.tokens);
  }
}

/**
 * Provider for `aitopia login`. Starts from no tokens (so the server asks for a
 * sign-in), keeps the new client registration in memory and writes client and
 * tokens together only once the code exchange succeeded, so an aborted login
 * leaves the previous session untouched.
 */
export class LoginProvider implements OAuthClientProvider {
  private client?: OAuthClientInformationMixed;
  private currentTokens?: OAuthTokens;
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  authorizationStarted = false;

  constructor(
    private readonly store: CredentialStore,
    private readonly serverUrl: string,
    readonly redirectUrl: string,
    private readonly expectedState: string,
    private readonly onAuthorizationUrl: (url: URL) => void | Promise<void>,
  ) {
    const stored = store.get(serverUrl)?.client;
    if (stored && redirectUrisOf(stored).includes(redirectUrl)) this.client = stored;
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadataFor(this.redirectUrl);
  }

  state(): string {
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.client = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.currentTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.currentTokens = tokens;
    const client = this.client;
    this.store.update(this.serverUrl, (entry) => ({ ...entry, client, tokens }));
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.authorizationStarted = true;
    await this.onAuthorizationUrl(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No sign-in in progress.');
    return this.verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') this.client = undefined;
    if (scope === 'all' || scope === 'tokens') this.currentTokens = undefined;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }
}

/** Only https links (http only to a loopback host) are opened in a browser. */
export function isSafeBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/** Opens a URL in the default browser. Resolves false when no browser could be started or the URL is not safe to open. */
export function openBrowser(url: string): Promise<boolean> {
  if (!isSafeBrowserUrl(url)) return Promise.resolve(false);
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    // rundll32 takes the URL as one argument, without cmd.exe parsing `&`.
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
