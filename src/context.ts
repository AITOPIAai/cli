import { credentialsPath, resolveServerUrl } from './config.js';
import { CredentialStore } from './credentials.js';
import { openSession, type Session } from './mcp.js';
import { Output } from './output.js';

export interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  server?: string;
}

export interface Context {
  serverUrl: string;
  out: Output;
  store: CredentialStore;
  log?: (line: string) => void;
  /** Opens a session with the stored sign-in (exit 3 if there is none). */
  session(): Promise<Session>;
}

export function createContext(options: GlobalOptions, out?: Output): Context {
  const output = out ?? new Output({ json: options.json, verbose: options.verbose });
  const serverUrl = resolveServerUrl(options.server);
  const store = new CredentialStore(credentialsPath(), { warn: (message) => output.warn(message) });
  const log = options.verbose ? (line: string) => output.debug(line) : undefined;
  return {
    serverUrl,
    out: output,
    store,
    log,
    session: () => openSession(store, serverUrl, log),
  };
}

/** Opens a session, runs `fn`, always closes the session. */
export async function withSession<T>(ctx: Context, fn: (session: Session) => Promise<T>): Promise<T> {
  const session = await ctx.session();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
