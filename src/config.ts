import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './errors.js';

export const DEFAULT_SERVER_URL = 'https://mcp.aitopia.ai/mcp';

type Env = Record<string, string | undefined>;

/** Server URL from --server, then AITOPIA_MCP_URL, then the default. Returned normalized. */
export function resolveServerUrl(flag: string | undefined, env: Env = process.env): string {
  const raw = (flag ?? env.AITOPIA_MCP_URL ?? '').trim() || DEFAULT_SERVER_URL;
  return normalizeServerUrl(raw);
}

export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`Invalid server URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new UsageError(`The server URL must use https (http is allowed only for localhost): ${raw}`);
  }
  url.hash = '';
  return url.href;
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/** Local config directory: $AITOPIA_CONFIG_DIR or ~/.aitopia (%USERPROFILE%\.aitopia on Windows). */
export function configDir(env: Env = process.env): string {
  const override = env.AITOPIA_CONFIG_DIR?.trim();
  if (override) return override;
  return join(homedir(), '.aitopia');
}

export function credentialsPath(env: Env = process.env): string {
  return join(configDir(env), 'credentials.json');
}
