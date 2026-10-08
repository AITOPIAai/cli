import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { Protocol, type RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpError, SUPPORTED_PROTOCOL_VERSIONS, type Implementation, type ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { StoredSessionProvider } from './auth.js';
import {
  cacheDir,
  DISCOVERY_TTL_MS,
  HANDSHAKE_TTL_MS,
  JsonCache,
  ServerCache,
  sha256Hex,
  TOOLS_TTL_MS,
} from './cache.js';
import { needsRefresh, type CredentialStore } from './credentials.js';
import { NotSignedInError, toCliError } from './errors.js';
import { isFailed, parseToolResult, type ToolOutcome } from './envelope.js';
import { UploadCache } from './upload.js';
import { userAgent, VERSION } from './version.js';

/** One MCP progress notification (the server sends one every ~3 s while a call works). */
export interface ServerProgress {
  /** Seconds the server has been working on the call. */
  progress: number;
  total?: number;
  /** e.g. "Generating image with GPT Image 2.5 — 9 s" */
  message?: string;
}

export interface CallOptions {
  /** Asks the server for live progress (sent as `_meta.progressToken`). */
  onProgress?: (progress: ServerProgress) => void;
  /** The call may spend credits: a broken connection then means "outcome unknown" (exit 5). */
  paid?: boolean;
}

/** Calls one tool and returns the parsed result. */
export type ToolCaller = (name: string, args: Record<string, unknown>, options?: CallOptions) => Promise<ToolOutcome>;

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface Session {
  serverUrl: string;
  callTool: ToolCaller;
  /** The tool list; from the local cache (1 h, same server version) unless `fresh`. */
  listTools(options?: { fresh?: boolean }): Promise<ToolInfo[]>;
  /** Uploaded-file cache for this server (undefined: every upload is sent). */
  uploads?: UploadCache;
  close(): Promise<void>;
}

/**
 * Silence allowed before a tool call is given up. Long calls send progress
 * every ~3 s (each one restarts the clock), so this only ends a dropped stream.
 */
export const TOOL_TIMEOUT_MS = 90_000;
/** get_run_status holds a call at most ~22 s (wait 20). */
export const STATUS_TIMEOUT_MS = 45_000;

/** fetch that logs method, URL and status to `log` (never headers or bodies, so no tokens). */
export function loggingFetch(log: ((line: string) => void) | undefined): FetchLike {
  return async (url, init) => {
    if (!log) return fetch(url, init);
    const method = init?.method ?? 'GET';
    const target = typeof url === 'string' ? url : url.toString();
    const started = Date.now();
    const headers = new Headers(init?.headers);
    const auth = headers.has('authorization') ? ' (Authorization: [redacted])' : '';
    log(`> ${method} ${redactQuery(target)}${auth}`);
    try {
      const res = await fetch(url, init);
      log(`< ${res.status} ${method} ${redactQuery(target)} ${Date.now() - started} ms`);
      return res;
    } catch (error) {
      log(`< failed ${method} ${redactQuery(target)}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
}

/** Hides query values (codes, states) in logged URLs. */
export function redactQuery(target: string): string {
  try {
    const url = new URL(target);
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '…');
    return url.toString();
  } catch {
    return target;
  }
}

export interface ConnectOptions {
  serverUrl: string;
  provider: OAuthClientProvider;
  log?: (line: string) => void;
}

export function createTransport(options: ConnectOptions): StreamableHTTPClientTransport {
  const transport = new StreamableHTTPClientTransport(new URL(options.serverUrl), {
    authProvider: options.provider,
    fetch: loggingFetch(options.log),
    requestInit: { headers: { 'User-Agent': userAgent() } },
  });
  transport.onerror = (error) => options.log?.(`transport: ${error.message}`);
  return transport;
}


/** What a cached initialize result keeps: enough to talk to a stateless server without initializing again. */
export interface HandshakeInfo {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo?: Implementation;
  /** sha256 of the server instructions (the text itself is not kept). */
  instructionsHash?: string;
}

export interface ToolsEntry {
  /** handshakeKey of the server that listed these tools. */
  key: string;
  tools: ToolInfo[];
}

/** Local caches a session uses; each is optional (none: every command does the full exchange). */
export interface SessionCaches {
  discovery?: ServerCache<OAuthDiscoveryState>;
  handshake?: ServerCache<HandshakeInfo>;
  tools?: ServerCache<ToolsEntry>;
  /** Builds the upload cache for one server. */
  uploads?: (serverUrl: string) => UploadCache;
}

export function defaultCaches(dir: string = cacheDir()): SessionCaches {
  const files = new JsonCache(dir);
  return {
    discovery: new ServerCache<OAuthDiscoveryState>(files, 'oauth', DISCOVERY_TTL_MS),
    handshake: new ServerCache<HandshakeInfo>(files, 'handshake', HANDSHAKE_TTL_MS),
    tools: new ServerCache<ToolsEntry>(files, 'tools', TOOLS_TTL_MS),
    uploads: (serverUrl) => new UploadCache(files, serverUrl),
  };
}

/** Drops what is cached for a server (after login or logout: another account may sign in). */
export function clearServerCaches(caches: SessionCaches, serverUrl: string): void {
  caches.handshake?.clear(serverUrl);
  caches.tools?.clear(serverUrl);
  caches.uploads?.(serverUrl).clearServer();
}

/** Server version + protocol + instructions: a tools/list cached under another key is stale. */
export function handshakeKey(info: HandshakeInfo): string {
  return sha256Hex(
    JSON.stringify([info.protocolVersion, info.serverInfo?.name ?? '', info.serverInfo?.version ?? '', info.instructionsHash ?? '']),
  ).slice(0, 24);
}

/**
 * Client that can resume a cached handshake: with `resume` set, connect()
 * attaches the transport and restores the server's protocol version and
 * capabilities instead of sending initialize + notifications/initialized.
 * Only used for a server that answered initialize without an mcp-session-id
 * (stateless: every request stands alone, so no request depends on an
 * initialize having been sent before it).
 */
export class CliClient extends Client {
  resume?: HandshakeInfo;

  constructor() {
    super({ name: 'aitopia-cli', version: VERSION });
  }

  override async connect(transport: Transport, options?: RequestOptions): Promise<void> {
    const cached = this.resume;
    if (!cached) return super.connect(transport, options);
    await (Protocol.prototype.connect as (this: unknown, t: Transport) => Promise<void>).call(this, transport);
    const self = this as unknown as { _serverCapabilities?: ServerCapabilities; _serverVersion?: Implementation };
    self._serverCapabilities = cached.capabilities;
    self._serverVersion = cached.serverInfo;
    transport.setProtocolVersion?.(cached.protocolVersion);
  }

  /** The initialize result to cache, or undefined (stateful server, or not initialized). */
  handshake(transport: StreamableHTTPClientTransport): HandshakeInfo | undefined {
    if (transport.sessionId !== undefined) return undefined;
    const capabilities = this.getServerCapabilities();
    const protocolVersion = transport.protocolVersion;
    if (!capabilities || !protocolVersion) return undefined;
    const instructions = this.getInstructions();
    return {
      protocolVersion,
      capabilities,
      serverInfo: this.getServerVersion(),
      ...(instructions ? { instructionsHash: sha256Hex(instructions) } : {}),
    };
  }
}

export function createClient(): CliClient {
  return new CliClient();
}

/** A cached handshake the SDK can still speak, else undefined. */
function usableHandshake(info: HandshakeInfo | undefined): HandshakeInfo | undefined {
  if (!info || typeof info.protocolVersion !== 'string' || !info.capabilities || typeof info.capabilities !== 'object') return undefined;
  return SUPPORTED_PROTOCOL_VERSIONS.includes(info.protocolVersion) ? info : undefined;
}

/**
 * A request the server refused because no initialize came first (a server
 * that turned stateful, or a protocol version it no longer takes). The server
 * answered 400 before running anything, so the request can be sent again.
 */
export function isHandshakeRejection(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) return error.code === 400;
  if (error instanceof McpError) return /not initialized|protocol version/i.test(error.message);
  return false;
}

/** A tools/call answer meaning the tool is not on this server (the cached tool list is stale). */
export function isToolNotFound(outcome: ToolOutcome): boolean {
  if (!isFailed(outcome)) return false;
  const { code, error } = outcome.payload;
  if (code === 'TOOL_NOT_FOUND') return true;
  return typeof error === 'string' && /\bunknown tool\b|\btool\b\S*\s.*\bnot found\b/i.test(error);
}

export interface SessionHooks {
  caches?: SessionCaches;
  /** handshakeKey of the server, for the tools/list cache. */
  toolsKey?: string;
  /** Set when the handshake was resumed: reconnects with a full initialize after a handshake rejection. */
  recover?: () => Promise<Client>;
  uploads?: UploadCache;
}

export function sessionFromClient(initial: Client, serverUrl: string, hooks: SessionHooks = {}): Session {
  let client = initial;
  let recover = hooks.recover;
  const caches = hooks.caches ?? {};

  /** Runs one request; the first one after a resumed handshake may reconnect once. */
  async function request<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    try {
      const result = await fn(client);
      recover = undefined;
      return result;
    } catch (error) {
      const again = recover;
      recover = undefined;
      if (!again || !isHandshakeRejection(error)) throw error;
      client = await again();
      return fn(client);
    }
  }

  const callOnce: ToolCaller = async (name, args, options) => {
    const onProgress = options?.onProgress;
    try {
      const result = await request((c) =>
        c.callTool({ name, arguments: args }, undefined, {
          timeout: name === 'get_run_status' ? STATUS_TIMEOUT_MS : TOOL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          // With onprogress the SDK sends a progressToken; the server then answers over SSE.
          ...(onProgress
            ? {
                onprogress: (p: ServerProgress) => {
                  try {
                    onProgress(p);
                  } catch {
                    // Progress display never breaks the call.
                  }
                },
              }
            : {}),
        }),
      );
      return parseToolResult(result as Record<string, unknown>);
    } catch (error) {
      throw toCliError(error, serverUrl, { paid: options?.paid === true });
    }
  };

  return {
    serverUrl,
    uploads: hooks.uploads,
    async callTool(name, args, options) {
      const outcome = await callOnce(name, args, options);
      if (!isFailed(outcome)) return outcome;
      if (isToolNotFound(outcome)) {
        caches.tools?.clear(serverUrl);
        caches.handshake?.clear(serverUrl);
      }
      // A file served from the upload cache that the server can no longer read: upload it again, once.
      const fresh = hooks.uploads ? await hooks.uploads.replaceGone(outcome, args, callOnce) : undefined;
      return fresh ? callOnce(name, fresh, options) : outcome;
    },
    async listTools(options) {
      const key = hooks.toolsKey;
      if (!options?.fresh && key) {
        const hit = caches.tools?.get(serverUrl);
        if (hit && hit.key === key && Array.isArray(hit.tools)) return hit.tools;
      }
      const tools: ToolInfo[] = [];
      let cursor: string | undefined;
      try {
        for (let page = 0; page < 50; page++) {
          const res = await request((c) => c.listTools(cursor ? { cursor } : undefined));
          for (const tool of res.tools) {
            tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> });
          }
          cursor = res.nextCursor;
          if (!cursor) break;
        }
      } catch (error) {
        throw toCliError(error, serverUrl);
      }
      if (key) caches.tools?.set(serverUrl, { key, tools });
      return tools;
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

/** fetch with the CLI's User-Agent (for the OAuth requests of an early refresh). */
function withUserAgent(fetchFn: FetchLike): FetchLike {
  return (url, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('user-agent')) headers.set('User-Agent', userAgent());
    return fetchFn(url, { ...init, headers });
  };
}

/**
 * Renews the access token before it is sent when it expires within a minute
 * (one token request when the discovery metadata is cached), instead of
 * waiting for the server's 401. A refresh that cannot be done for a network
 * or server reason is left to the usual 401 path.
 */
async function refreshEarly(provider: StoredSessionProvider, serverUrl: string, log?: (line: string) => void): Promise<void> {
  try {
    const result = await auth(provider, { serverUrl: new URL(serverUrl), fetchFn: withUserAgent(loggingFetch(log)) });
    log?.(`access token renewed before expiry (${result})`);
  } catch (error) {
    if (error instanceof NotSignedInError) throw error;
    // Possibly stale metadata: discover again next time.
    provider.dropDiscovery();
    log?.(`early token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Opens a session with the stored sign-in. Never starts a browser sign-in. */
export async function openSession(
  store: CredentialStore,
  serverUrl: string,
  log?: (line: string) => void,
  caches: SessionCaches = {},
): Promise<Session> {
  const stored = store.get(serverUrl);
  if (!stored?.tokens || !stored.client) throw new NotSignedInError();
  const provider = new StoredSessionProvider(store, serverUrl, caches.discovery);
  if (needsRefresh(stored)) await refreshEarly(provider, serverUrl, log);

  const connect = async (resume: HandshakeInfo | undefined): Promise<{ client: CliClient; key?: string }> => {
    const transport = createTransport({ serverUrl, provider, log });
    const client = createClient();
    client.resume = resume;
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw toCliError(error, serverUrl);
    }
    if (resume) {
      log?.('handshake resumed from cache (no initialize)');
      return { client, key: handshakeKey(resume) };
    }
    const info = client.handshake(transport);
    if (info) caches.handshake?.set(serverUrl, info);
    else caches.handshake?.clear(serverUrl);
    return { client, ...(info ? { key: handshakeKey(info) } : {}) };
  };

  const cached = usableHandshake(caches.handshake?.get(serverUrl));
  const first = await connect(cached);
  const uploads = caches.uploads?.(serverUrl);
  return sessionFromClient(first.client, serverUrl, {
    caches,
    toolsKey: first.key,
    uploads,
    ...(cached
      ? {
          recover: async () => {
            log?.('server refused the cached handshake; initializing again');
            caches.handshake?.clear(serverUrl);
            caches.tools?.clear(serverUrl);
            await first.client.close().catch(() => undefined);
            return (await connect(undefined)).client;
          },
        }
      : {}),
  });
}
