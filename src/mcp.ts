import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StoredSessionProvider } from './auth.js';
import type { CredentialStore } from './credentials.js';
import { NotSignedInError, toCliError } from './errors.js';
import { parseToolResult, type ToolOutcome } from './envelope.js';
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
  listTools(): Promise<ToolInfo[]>;
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

export function createClient(): Client {
  return new Client({ name: 'aitopia-cli', version: VERSION });
}

export function sessionFromClient(client: Client, serverUrl: string): Session {
  return {
    serverUrl,
    async callTool(name, args, options) {
      const onProgress = options?.onProgress;
      try {
        const result = await client.callTool({ name, arguments: args }, undefined, {
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
        });
        return parseToolResult(result as Record<string, unknown>);
      } catch (error) {
        throw toCliError(error, serverUrl, { paid: options?.paid === true });
      }
    },
    async listTools() {
      const tools: ToolInfo[] = [];
      let cursor: string | undefined;
      try {
        for (let page = 0; page < 50; page++) {
          const res = await client.listTools(cursor ? { cursor } : undefined);
          for (const tool of res.tools) {
            tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> });
          }
          cursor = res.nextCursor;
          if (!cursor) break;
        }
      } catch (error) {
        throw toCliError(error, serverUrl);
      }
      return tools;
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

/** Opens a session with the stored sign-in. Never starts a browser sign-in. */
export async function openSession(store: CredentialStore, serverUrl: string, log?: (line: string) => void): Promise<Session> {
  const stored = store.get(serverUrl);
  if (!stored?.tokens || !stored.client) throw new NotSignedInError();
  const provider = new StoredSessionProvider(store, serverUrl);
  const transport = createTransport({ serverUrl, provider, log });
  const client = createClient();
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw toCliError(error, serverUrl);
  }
  return sessionFromClient(client, serverUrl);
}
