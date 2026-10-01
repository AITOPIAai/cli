import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { STATUS_TIMEOUT_MS, TOOL_TIMEOUT_MS, sessionFromClient } from '../src/mcp.js';

describe('tool call timeouts', () => {
  const fakeClient = () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"status":"completed"}' }] }));
    return { client: { callTool } as unknown as Client, callTool };
  };

  it('a dropped stream ends after ~90 s of silence (progress resets it), get_run_status after ~45 s', async () => {
    expect(TOOL_TIMEOUT_MS).toBe(90_000);
    expect(STATUS_TIMEOUT_MS).toBe(45_000);
    const { client, callTool } = fakeClient();
    const session = sessionFromClient(client, 'https://mcp.aitopia.ai/mcp');
    await session.callTool('generate_image', { prompt: 'x' }, { onProgress: () => undefined, paid: true });
    await session.callTool('get_run_status', { runToken: 't', wait: 20 });
    const calls = callTool.mock.calls as unknown as Array<[unknown, unknown, { timeout: number; resetTimeoutOnProgress: boolean; onprogress?: unknown }]>;
    expect(calls[0]?.[2]).toMatchObject({ timeout: TOOL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    expect(typeof calls[0]?.[2].onprogress).toBe('function');
    expect(calls[1]?.[2]).toMatchObject({ timeout: STATUS_TIMEOUT_MS });
  });

  it('a broken connection after a paid call is exit 5, after a free call exit 1', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const client = { callTool: vi.fn(async () => Promise.reject(reset)) } as unknown as Client;
    const session = sessionFromClient(client, 'https://mcp.aitopia.ai/mcp');
    await expect(session.callTool('run_model', {}, { paid: true })).rejects.toMatchObject({ exitCode: 5 });
    await expect(session.callTool('list_models', {})).rejects.toMatchObject({ exitCode: 1 });
  });
});
