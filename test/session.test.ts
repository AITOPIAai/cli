import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../src/context.js';
import { CredentialStore } from '../src/credentials.js';
import { Output } from '../src/output.js';
import { imageCommand } from '../src/commands/image.js';
import { videoCommand } from '../src/commands/video.js';
import { creditsCommand } from '../src/commands/credits.js';
import { toolsCommand } from '../src/commands/tools.js';
import { loginCommand } from '../src/commands/login.js';
import { CliError } from '../src/errors.js';
import { clearReadyResults, reportInterrupt } from '../src/interrupt.js';
import { jsonStatus } from '../src/cli.js';
import { batchCommand } from '../src/commands/batch.js';
import { runCommand } from '../src/commands/run.js';
import { statusCommand } from '../src/commands/status.js';

// A local stand-in for the AITOPIA MCP server (no internet involved). Shapes
// follow scotty's src/mcp: media-tool-executor.ts (generate_image,
// MODEL_REQUIRED), marketplace-tool-executor.ts (list_models, run_model,
// get_run_status, get_credit_balance), result-envelope.ts normalizeFailure
// (unknown keys move under `details`; a plain-text error gets an inferred
// code), run-status.ts (wait, runTokens, RUN_STALE, INVALID_RUN_TOKEN),
// cost-estimate.ts (dryRun {status:"estimate"}), model-errors.ts
// (MODEL_NOT_FOUND + suggestions), batch-generate.ts (generate_batch) and
// tool-progress.ts / streamable-server.ts (a tools/call with
// _meta.progressToken is answered over SSE with notifications/progress).
type Call = { name: string; args: Record<string, unknown>; progressToken?: unknown };
let calls: Call[] = [];
let http: HttpServer;
let base: string;
let rejectAll = false;
let imageModels: Array<Record<string, unknown>> = [];
let runOutput: Record<string, unknown> = {};
let brokenFiles = false;
let revocationEndpoint = '';
let revoked: string[] = [];
/** runToken -> the bodies get_run_status answers in turn (the last one repeats). */
let runStates: Record<string, Array<Record<string, unknown>>> = {};
let progressDelayMs = 0;
let batchUnavailable = false;
/** withWaitNote: the next get_run_status answer carries this top-level note (the per-user waiting cap was full). */
let waitNoteOnce = '';
let balance = 8951;

const ok = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
// normalizeFailure: {status:'failed', code, error, retryable?, ...}; also in structuredContent.
const fail = (body: Record<string, unknown>) => {
  const payload = { status: 'failed', ...body };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true, structuredContent: payload };
};
const openLink = (uri: string) => ({ type: 'resource_link', uri, name: 'Open in AITOPIA', title: 'Open in AITOPIA', mimeType: 'text/html' });

const SUGGESTIONS = [{ id: 'google/nano-banana-2', displayName: 'Nano Banana 2', mediaType: 'image' }];

// modelNotFoundPayload after normalizeFailure.
const modelNotFound = (modelId: string) =>
  fail({
    code: 'MODEL_NOT_FOUND',
    error: `There is no AITOPIA image model with the id "${modelId}". Use one of the suggestions.`,
    modelId,
    retryable: false,
    suggestions: SUGGESTIONS,
    hint: 'Call list_models (type "image") and use an id it returns. Never guess or assemble a model id. Nothing was spent.',
  });

// buildEstimateBody
const estimate = (credits: number, basis: string, modelId: string) => {
  const affordable = balance >= credits;
  return ok({
    status: 'estimate',
    credits,
    basis,
    modelId,
    balance: { creditsForGeneration: balance },
    affordable,
    note: 'Estimate only: nothing was submitted, reserved or charged. Run the same call without dryRun to start it.',
    ...(affordable ? {} : { buyCreditsUrl: 'https://aitopia.ai/pricing', hint: 'Do not start it.' }),
  });
};

const INVALID_TOKEN_TEXT = 'Invalid, expired or unrecognized runToken.';

function runBody(token: string): Record<string, unknown> | undefined {
  const queue = runStates[token];
  if (!queue) return undefined;
  return (queue.length > 1 ? queue.shift() : queue[0]) as Record<string, unknown>;
}

// run-status.ts getRunStatus (single token: that run's own result; runTokens: runsToResult).
function runStatus(args: Record<string, unknown>) {
  if (Array.isArray(args.runTokens)) {
    if ((args.runTokens as string[]).includes('limited')) {
      return fail({ code: 'RATE_LIMIT', error: 'Rate limit exceeded for this tool. Try again shortly or poll less frequently.', retryable: true, retryAfterSeconds: 1 });
    }
    const items = (args.runTokens as string[]).map((token, index) => {
      const body: Record<string, unknown> = runBody(token) ?? { status: 'failed', code: 'INVALID_RUN_TOKEN', error: INVALID_TOKEN_TEXT };
      // runsToResult: {index, ...body, status: itemStatus} — failed / running / anything else is completed.
      const status = body.status === 'failed' ? 'failed' : body.status === 'running' ? 'running' : 'completed';
      return { index, ...body, status } as Record<string, unknown> & { index: number; status: string };
    });
    const statuses = items.map((i) => i.status);
    const status = statuses.includes('running')
      ? 'running'
      : statuses.every((x) => x === 'completed')
        ? 'completed'
        : statuses.every((x) => x === 'failed')
          ? 'failed'
          : 'partial';
    const assets = items.filter((i) => i.status === 'completed' && typeof (i as { assetUrl?: unknown }).assetUrl === 'string');
    const waitNote = waitNoteOnce;
    waitNoteOnce = '';
    return ok({ status, items, pollAfterMs: 2000, ...(assets.length > 0 ? { assets } : {}), ...(waitNote ? { waitNote } : {}) });
  }
  const token = String(args.runToken);
  const body = runBody(token);
  if (body) return body.status === 'failed' ? fail(body) : ok(body);
  if (token !== 'run-1') {
    // A plain-text fail(); normalizeFailure infers NOT_FOUND from "unrecognized runToken".
    return fail({ code: 'NOT_FOUND', error: INVALID_TOKEN_TEXT, retryable: false });
  }
  return ok({ status: 'completed', modelId: 'acme/i2v', jobId: 'job-1', runId: 'r-1', progress: 100, assetUrl: `${base}/files/5a19fd89-0c1e_output_0.mp4`, output: {}, ...runOutput, openInAitopia: 'https://aitopia.ai/c/2' });
}

// batch-generate.ts executeGenerateBatch. Models: "slow/x" -> SLOT_TIMEOUT,
// "nope/x" -> MODEL_NOT_FOUND; images finish inline, videos keep running.
function generateBatch(args: Record<string, unknown>) {
  const items = args.items as Array<Record<string, unknown>>;
  if (!Array.isArray(items) || items.length < 1 || items.length > 12) return fail({ code: 'INVALID_INPUT', error: 'items must hold 1 to 12 items.' });
  if (args.dryRun === true) {
    const rows = items.map((item, index) => {
      const head = { index, kind: item.kind, modelId: item.modelId ?? null };
      if (item.modelId === 'nope/x') {
        return { ...head, credits: null, code: 'MODEL_NOT_FOUND', error: '"nope/x" is not an available image model; this item would be refused.', suggestions: SUGGESTIONS };
      }
      return item.kind === 'video'
        ? { ...head, credits: 50, basis: '5 s x 10 credits per second at 720p.' }
        : { ...head, credits: 4, basis: '1 image x 4 credits.' };
    });
    const priced = rows.filter((r) => typeof r.credits === 'number') as Array<{ credits: number }>;
    return ok({ status: 'dry_run', dryRun: true, totalCredits: priced.reduce((a, r) => a + r.credits, 0), complete: priced.length === rows.length, items: rows, note: 'Nothing was submitted or charged.' });
  }
  if (batchUnavailable) {
    return fail({ code: 'BATCH_UNAVAILABLE', error: 'Batches are unavailable right now (the run store is down).', retryable: true });
  }
  const results = items.map((item, index) => {
    const head = { index, kind: item.kind, modelId: item.modelId };
    if (item.modelId === 'slow/x') {
      return { ...head, status: 'failed', code: 'SLOT_TIMEOUT', error: 'This item waited 30 minutes for your other generations to finish and was not started. Nothing was submitted or charged; run it again.', retryable: true };
    }
    if (item.modelId === 'nope/x') {
      return { ...head, status: 'failed', code: 'MODEL_NOT_FOUND', error: '"nope/x" is not an available model.', suggestions: SUGGESTIONS };
    }
    if (item.modelId === 'poor/x') {
      return { ...head, status: 'failed', code: 'INSUFFICIENT_CREDITS', error: 'Insufficient credits for this generation.', requiredCredits: 40, availableCredits: 3, retryable: false };
    }
    if (item.modelId === 'multi/x') {
      return { ...head, status: 'completed', assets: [{ assetUrl: `${base}/files/m-a.png` }, { assetUrl: `${base}/files/m-b.png` }] };
    }
    if (item.kind === 'video') {
      const runToken = `vid-${index}`;
      runStates[runToken] ??= [{ status: 'completed', modelId: item.modelId, jobId: `job-${index}`, assetUrl: `${base}/files/vid-${index}.mp4`, assetName: 'Server Video Name' }];
      return { ...head, status: 'running', runToken, progress: null, etaSeconds: 40, pollAfterMs: 2000 };
    }
    const ext = item.kind === 'audio' ? 'mp3' : 'png';
    return { ...head, status: 'completed', assetUrl: `${base}/files/batch-${index}.${ext}`, assetName: `Server Name ${index + 1}`, creationUrl: `https://aitopia.ai/creations/b${index}` };
  });
  const statuses = results.map((r) => r.status);
  const status = statuses.includes('running') ? 'running' : statuses.every((x) => x === 'completed') ? 'completed' : statuses.every((x) => x === 'failed') ? 'failed' : 'partial';
  const pending = results.filter((r) => r.status === 'running');
  const assets = results.filter((r) => r.status === 'completed');
  return ok({
    status,
    items: results,
    pollAfterMs: 5000,
    ...(assets.length > 0 ? { assets } : {}),
    ...(pending.length > 0 ? { runTokens: pending.map((r) => (r as { runToken: string }).runToken), next: 'Call get_run_status with runTokens and wait: 20.' } : {}),
  });
}

function tool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'get_run_status':
      return runStatus(args);
    case 'generate_batch':
      return generateBatch(args);
    case 'get_credit_balance':
      // Agent-scoped plan: the account reads unlimited, generations spend agentBalance.
      return ok({
        creditsForGeneration: 8951,
        creditsNote: 'Generations spend agentBalance; the account-level fields below do not limit them.',
        totalCredits: -999,
        paidCreditsBalance: 0,
        dailyCreditsRemaining: 0,
        dailyAllowanceCredits: 0,
        unlimited: true,
        agentBalance: { totalCredits: 8951, paidCreditsBalance: 8951, dailyCreditsRemaining: 0, dailyAllowanceCredits: 0, unlimited: false },
      });
    case 'generate_image': {
      if (!args.selectedModelId) {
        return fail({
          code: 'MODEL_REQUIRED',
          error: 'Choose the image model for this job (selectedModelId): follow the loaded skill\'s model guidance, or pick from these — AITOPIA\'s current image models, most used first — or search list_models (type "image") by capability. Nothing was spent.',
          suggestions: [{ id: 'google/nano-banana-2', displayName: 'Nano Banana 2', mediaType: 'image' }],
          retryable: true,
        });
      }
      if (String(args.selectedModelId).endsWith('-99')) return modelNotFound(String(args.selectedModelId));
      if (args.dryRun === true) {
        const count = typeof args.count === 'number' ? args.count : 1;
        return estimate(4 * count, `${count} image${count > 1 ? 's' : ''} x 4 credits.`, String(args.selectedModelId));
      }
      const prompt = String(args.prompt);
      const baseName = prompt.length > 26 ? `${prompt.slice(0, 26)}…` : prompt;
      const count = typeof args.count === 'number' ? args.count : 1;
      if (count > 1) {
        const assets = Array.from({ length: count }, (_, i) => ({
          assetUrl: `${base}/files/img-${i}.png`,
          assetName: `${baseName} ${i + 1}`,
          creationUrl: `https://aitopia.ai/creations/${i}`,
          modelId: args.selectedModelId,
          prompt,
        }));
        return ok({ status: 'completed', assetUrl: assets[0]?.assetUrl, assetName: assets[0]?.assetName, modelId: args.selectedModelId, assets, openInAitopia: 'https://aitopia.ai/c/1' });
      }
      return {
        content: [
          { type: 'text', text: JSON.stringify({ status: 'completed', assetUrl: `${base}/files/abc.png`, creationUrl: 'https://aitopia.ai/creations/1', assetName: baseName, modelId: args.selectedModelId, openInAitopia: 'https://aitopia.ai/c/1' }) },
          { type: 'resource_link', uri: `${base}/files/abc.png`, name: baseName, title: baseName, description: 'The generated file.', mimeType: 'image/png' },
          openLink('https://aitopia.ai/c/1'),
        ],
      };
    }
    case 'list_models': {
      const byType: Record<string, Array<Record<string, unknown>>> = {
        image: imageModels,
        video: [
          { id: 'bytedance/seedance-1-lite', capabilities: ['image-to-video', 'text-to-video'], mediaType: 'video', recommended: true },
          { id: 'acme/i2v', capabilities: ['image-to-video'], mediaType: 'video', current: true, recommended: false },
        ],
      };
      const models = byType[String(args.type)] ?? [];
      return ok({ modelCount: models.length, returned: models.length, truncated: false, nextOffset: null, models });
    }
    case 'get_model_schema': {
      const schemas: Record<string, unknown> = {
        'google/nano-banana-2': { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'] } } },
        'acme/i2v': { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, start_image_url: { type: 'string' }, duration: { type: 'integer' } } },
      };
      const schema = schemas[String(args.modelId) === 'acme/unpriced' ? 'acme/i2v' : String(args.modelId)];
      if (!schema) return fail({ code: 'NOT_FOUND', error: `Unknown model ${String(args.modelId)}`, retryable: false });
      return ok({ modelId: args.modelId, schema });
    }
    case 'upload_asset':
      return ok({ status: 'completed', assetUrl: 'https://cdn.aitopia.ai/uploaded.png', assetName: String(args.fileName), contentType: 'image/png', sizeBytes: 8 });
    case 'run_model':
      if (args.dryRun === true) {
        if (args.modelId === 'acme/unpriced') {
          return fail({ code: 'PRICE_UNKNOWN', error: 'This model lists no price, so it cannot be estimated before it runs. Nothing was spent.', retryable: false, modelId: args.modelId, hint: 'Run it without dryRun only if the user accepts an unknown price.' });
        }
        return estimate(50, '5 s x 10 credits per second at 720p.', String(args.modelId));
      }
      return ok({ status: 'running', modelId: args.modelId, jobId: 'job-1', runToken: 'run-1', progress: null, queuePosition: null, etaSeconds: null, pollAfterMs: 2000 });
    default:
      return fail({ code: 'NOT_FOUND', error: `Unknown tool ${name}`, retryable: false });
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', base);
  if (url.pathname.startsWith('/files/')) {
    if (brokenFiles) {
      res.writeHead(503).end();
      return;
    }
    const type = url.pathname.endsWith('.png') ? 'image/png' : url.pathname.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
    res.writeHead(200, { 'Content-Type': type });
    res.end(`bytes of ${url.pathname}`);
    return;
  }
  if (await oauthRoute(url, req, res)) return;
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  if (rejectAll || req.headers.authorization !== 'Bearer good-token') {
    res
      .writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      })
      .end('{"error":"invalid_token"}');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const body = await readBody(req);
  // streamable-server.ts: a tools/call with a progressToken is answered as SSE.
  const wantsProgress = Boolean((body as { method?: string; params?: { _meta?: { progressToken?: unknown } } } | undefined)?.params?._meta?.progressToken !== undefined);
  const server = new Server({ name: 'fake-aitopia', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'generate_image', description: 'Generate images. Long text.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, dryRun: { type: 'boolean' } } } },
      { name: 'get_credit_balance', description: 'Credits.', inputSchema: { type: 'object' } },
      { name: 'create_product', description: 'Create a Shopify product.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const progressToken = request.params._meta?.progressToken;
    calls.push({ name: request.params.name, args, ...(progressToken !== undefined ? { progressToken } : {}) });
    if (progressToken !== undefined && request.params.name !== 'get_run_status') {
      // tool-progress.ts: one at once, then every ~3 s with the elapsed seconds.
      const label = request.params.name === 'generate_batch' ? 'Running 3 generations' : 'Generating image with Nano Banana 2';
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: 0, message: label } });
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: 3, message: `${label} — 3 s` } });
      if (progressDelayMs) await new Promise((r) => setTimeout(r, progressDelayMs));
    }
    return tool(request.params.name, args);
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !wantsProgress });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

let registered: Record<string, unknown>[] = [];
let tokenRequests: URLSearchParams[] = [];

// Minimal OAuth 2.1 authorization server: metadata, registration, token.
async function oauthRoute(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const send = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    send(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/`], scopes_supported: ['mcp'] });
    return true;
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    send(200, {
      issuer: `${base}/`,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: revocationEndpoint || `${base}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    return true;
  }
  if (url.pathname === '/register' && req.method === 'POST') {
    const body = (await readBody(req)) as Record<string, unknown>;
    registered.push(body);
    send(201, { ...body, client_id: `client-${registered.length}` });
    return true;
  }
  if (url.pathname === '/revoke' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    revoked.push(new URLSearchParams(Buffer.concat(chunks).toString()).get('token_type_hint') ?? '');
    res.writeHead(200).end();
    return true;
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    tokenRequests.push(params);
    if (params.get('grant_type') === 'refresh_token' && params.get('refresh_token') === 'refresh-1') {
      send(200, { access_token: 'good-token', token_type: 'Bearer', refresh_token: 'refresh-2' });
      return true;
    }
    if (params.get('code') !== 'auth-code') {
      send(400, { error: 'invalid_grant' });
      return true;
    }
    send(200, { access_token: 'good-token', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 });
    return true;
  }
  return false;
}

class Capture extends Writable {
  text = '';
  isTTY = false;
  columns = 100;
  override _write(chunk: Buffer, _enc: string, done: () => void) {
    this.text += chunk.toString();
    done();
  }
}

let dir: string;
let stdout: Capture;
let stderr: Capture;

function ctx(jsonMode = false, opts: { verbose?: boolean; tty?: boolean } = {}) {
  stdout = new Capture();
  stderr = new Capture();
  stderr.isTTY = opts.tty === true;
  const out = new Output({ json: jsonMode, verbose: opts.verbose, stdout, stderr, env: { NO_COLOR: '1' } });
  return createContext({ server: `${base}/mcp`, json: jsonMode }, out);
}

beforeAll(async () => {
  http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => http.close(resolve));
});

beforeEach(() => {
  calls = [];
  imageModels = [
    { id: 'tencentarc/gfpgan', capabilities: ['face-restoration'], mediaType: 'image', recommended: true },
    { id: 'black-forest-labs/flux-schnell', capabilities: ['image-generation'], mediaType: 'image', recommended: true },
    { id: 'google/nano-banana-2', capabilities: ['image-generation'], mediaType: 'image', current: true },
  ];
  runOutput = {};
  runStates = {};
  clearReadyResults();
  progressDelayMs = 0;
  batchUnavailable = false;
  waitNoteOnce = '';
  balance = 8951;
  brokenFiles = false;
  revocationEndpoint = '';
  revoked = [];
  registered = [];
  tokenRequests = [];
  rejectAll = false;
  dir = mkdtempSync(join(tmpdir(), 'aitopia-session-'));
  vi.stubEnv('AITOPIA_CONFIG_DIR', join(dir, 'config'));
  vi.stubEnv('AITOPIA_MCP_URL', '');
  const store = new CredentialStore(join(dir, 'config', 'credentials.json'));
  store.update(`${base}/mcp`, (e) => ({
    ...e,
    client: { client_id: 'cli-client', redirect_uris: ['http://127.0.0.1:1/callback'] } as never,
    tokens: { access_token: 'good-token', token_type: 'Bearer' },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('commands against a local MCP server', () => {
  it('credits shows the balance generations spend, not the account-level unlimited', async () => {
    await creditsCommand(ctx());
    expect(stdout.text.trim()).toBe('Credits: 8,951 available');
  });

  it('image picks a current model (server order, not recommended), maps --aspect and saves under a clean name', async () => {
    const out = join(dir, 'out');
    await imageCommand(ctx(), ['a', 'small', 'paper', 'boat', 'on', 'calm', 'water', 'at', 'dawn'], { output: `${out}/`, aspect: '16:9' });
    expect(calls.map((c) => c.name)).toEqual(['list_models', 'get_model_schema', 'generate_image']);
    expect(calls[0]?.args).toEqual({ type: 'image', limit: 20 });
    expect(calls[2]?.args).toEqual({
      prompt: 'a small paper boat on calm water at dawn',
      selectedModelId: 'google/nano-banana-2',
      input: { aspect_ratio: '16:9' },
    });
    expect(stderr.text).toContain('Model: google/nano-banana-2');
    expect(readdirSync(out)).toEqual(['a-small-paper-boat-on-calm-water-at-dawn.png']);
    expect(stdout.text).toContain('Open in AITOPIA: https://aitopia.ai/c/1');
  });

  it('image rejects an --aspect the model does not accept, before generating', async () => {
    const error = (await imageCommand(ctx(), ['fox'], { aspect: '4:3' }).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(2);
    expect(error.hint).toContain('1:1, 16:9, 9:16');
    expect(calls.map((c) => c.name)).not.toContain('generate_image');
  });

  it('image retries once with the first suggestion when the server answers MODEL_REQUIRED', async () => {
    imageModels = [];
    await imageCommand(ctx(true), ['fox'], { output: `${join(dir, 'o')}/` });
    expect(calls.map((c) => c.name)).toEqual(['list_models', 'generate_image', 'generate_image']);
    expect(calls[1]?.args.selectedModelId).toBeUndefined();
    expect(calls[2]?.args).toMatchObject({ selectedModelId: 'google/nano-banana-2' });
    expect(calls[2]?.args.allowAnyModel).toBeUndefined();
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'completed', modelId: 'google/nano-banana-2' });
  });

  it('--model sends allowAnyModel; -n 3 saves name-1..3; --json prints one object', async () => {
    const out = join(dir, 'batch');
    await imageCommand(ctx(true), ['minimal', 'logo', 'of', 'a', 'paper', 'boat'], { output: `${out}/`, model: 'google/nano-banana-2', count: 3 });
    expect(calls.map((c) => c.name)).toEqual(['generate_image']);
    expect(calls[0]?.args).toMatchObject({ selectedModelId: 'google/nano-banana-2', allowAnyModel: true, count: 3 });
    const parsed = JSON.parse(stdout.text) as { files: string[] };
    expect(parsed.files.map((f) => f.slice(out.length + 1))).toEqual([
      'minimal-logo-of-a-paper-boat-1.png',
      'minimal-logo-of-a-paper-boat-2.png',
      'minimal-logo-of-a-paper-boat-3.png',
    ]);
  });

  it('a failed download still shows the paid result and says not to generate again', async () => {
    brokenFiles = true;
    const error = (await imageCommand(ctx(), ['fox'], { output: `${join(dir, 'o')}/` }).catch((e: unknown) => e)) as CliError;
    expect(error.code).toBe('DOWNLOAD_FAILED');
    expect(error.exitCode).toBe(1);
    expect(error.hint).toBe('The result is ready; do not generate it again. Download it from the URL above.');
    expect(stdout.text).toContain(`${base}/files/abc.png`);
    expect(stdout.text).toContain('Open in AITOPIA: https://aitopia.ai/c/1');
    expect(error.data.assetUrls).toEqual([`${base}/files/abc.png`]);
  });

  it('video picks a current model, uploads a local image, runs the model once and polls to the result', async () => {
    const image = join(dir, 'fox.png');
    writeFileSync(image, 'tiny png');
    const out = join(dir, 'clips');
    await videoCommand(ctx(), ['the', 'fox', 'blinks'], { image, duration: '5', output: `${out}/` });
    expect(calls.map((c) => c.name)).toEqual(['list_models', 'get_model_schema', 'upload_asset', 'run_model', 'get_run_status']);
    expect(calls[3]?.args).toEqual({
      modelId: 'acme/i2v',
      input: { prompt: 'the fox blinks', duration: 5, start_image_url: 'https://cdn.aitopia.ai/uploaded.png' },
    });
    // The paid call asks for live progress; the status check long-polls on the server.
    expect(calls[3]?.progressToken).toBeDefined();
    expect(calls[4]?.args).toEqual({ runToken: 'run-1', wait: 20 });
    // Named after the prompt, not the provider's file id.
    expect(readdirSync(out)).toEqual(['the-fox-blinks.mp4']);
  }, 15_000);

  it('run_model with assetUrl null finds the file inside output', async () => {
    runOutput = { assetUrl: null, output: { video: { url: `${base}/files/nested.mp4` }, seed: 1 } };
    const out = join(dir, 'nested');
    await videoCommand(ctx(), ['waves'], { model: 'acme/i2v', output: `${out}/` });
    expect(readdirSync(out)).toEqual(['waves.mp4']);
    expect(calls[1]?.args.allowAnyModel).toBe(true);
  }, 15_000);

  it('warns and prints the result when a finished run has no file', async () => {
    runOutput = { assetUrl: null, output: { status: 'done' } };
    await videoCommand(ctx(), ['waves'], { model: 'acme/i2v' });
    expect(stderr.text).toContain('returned no file');
    expect(stdout.text).toContain('"jobId": "job-1"');
  }, 15_000);

  it('logout revokes only at a same-origin endpoint', async () => {
    const { logoutCommand } = await import('../src/commands/logout.js');
    const store = new CredentialStore(join(dir, 'config', 'credentials.json'));
    const seed = () =>
      store.update(`${base}/mcp`, (e) => ({ ...e, client: { client_id: 'c' }, tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' } }));
    seed();
    await logoutCommand(ctx());
    expect(revoked.sort()).toEqual(['access_token', 'refresh_token']);

    seed();
    revoked = [];
    revocationEndpoint = 'https://evil.example.com/revoke';
    await logoutCommand(ctx());
    expect(revoked).toEqual([]);
    expect(store.get(`${base}/mcp`)).toBeUndefined();
  });

  it('upload keeps the successful uploads when another one fails (--json)', async () => {
    const { uploadCommand } = await import('../src/commands/upload.js');
    const good = join(dir, 'good.png');
    writeFileSync(good, 'png');
    const error = (await uploadCommand(ctx(true), [good, join(dir, 'missing.png')]).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(2);
    expect(error.data).toMatchObject({
      status: 'partial',
      uploads: [{ source: good, assetUrl: 'https://cdn.aitopia.ai/uploaded.png', fileName: 'good.png' }],
      failed: [{ source: join(dir, 'missing.png'), code: 'USAGE' }],
    });
  });

  it('tools lists names with one-line descriptions', async () => {
    await toolsCommand(ctx(), {});
    expect(stdout.text).toMatch(/generate_image\s+Generate images\./);
  });

  it('exits 3 without opening a browser when the server rejects the session', async () => {
    rejectAll = true;
    const error = (await creditsCommand(ctx()).catch((e: unknown) => e)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(3);
    expect(error.message).toMatch(/aitopia login/);
  });

  it('exits 3 when nothing is stored', async () => {
    rmSync(join(dir, 'config'), { recursive: true, force: true });
    const error = (await creditsCommand(ctx()).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe('Not signed in. Run `aitopia login`.');
  });

  it('login registers a loopback client, completes the code flow and stores the session', async () => {
    rmSync(join(dir, 'config'), { recursive: true, force: true });
    const context = ctx();
    const done = loginCommand(context, { browser: false });

    // Act as the browser: read the printed link and follow the redirect.
    let authUrl: URL | undefined;
    for (let i = 0; i < 200 && !authUrl; i++) {
      const match = /(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/.exec(stderr.text);
      if (match?.[1]) authUrl = new URL(match[1]);
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(authUrl).toBeDefined();
    const redirect = authUrl!.searchParams.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(authUrl!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl!.searchParams.get('resource')).toBe(`${base}/mcp`);

    const bad = await fetch(`${redirect}?code=auth-code&state=forged`);
    expect(bad.status).toBe(400);
    const good = await fetch(`${redirect}?code=auth-code&state=${authUrl!.searchParams.get('state')}`);
    expect(good.status).toBe(200);
    await done;

    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ client_name: 'AITOPIA CLI', redirect_uris: [redirect], token_endpoint_auth_method: 'none' });
    expect(tokenRequests[0]?.get('code_verifier')).toBeTruthy();
    expect(stdout.text).toContain('Signed in to');
    const stored = new CredentialStore(join(dir, 'config', 'credentials.json')).get(`${base}/mcp`);
    expect(stored?.tokens?.access_token).toBe('good-token');
    expect(stored?.client?.client_id).toBe('client-1');
    // The token never reaches the terminal.
    expect(stdout.text + stderr.text).not.toContain('good-token');
    expect(stdout.text + stderr.text).not.toContain('refresh-1');
  }, 15_000);

  it('refreshes an expired access token by itself and saves the new tokens', async () => {
    const store = new CredentialStore(join(dir, 'config', 'credentials.json'));
    store.update(`${base}/mcp`, (e) => ({
      ...e,
      client: { client_id: 'cli-client', redirect_uris: ['http://127.0.0.1:1/callback'], issuer: `${base}/` } as never,
      tokens: { access_token: 'expired', token_type: 'Bearer', refresh_token: 'refresh-1', issuer: `${base}/` } as never,
    }));
    await creditsCommand(ctx());
    expect(stdout.text).toContain('Credits: 8,951 available');
    expect(tokenRequests[0]?.get('grant_type')).toBe('refresh_token');
    expect(store.get(`${base}/mcp`)?.tokens).toMatchObject({ access_token: 'good-token', refresh_token: 'refresh-2' });
  });

  it('a rejected refresh token means signing in again (exit 3)', async () => {
    const store = new CredentialStore(join(dir, 'config', 'credentials.json'));
    store.update(`${base}/mcp`, (e) => ({
      ...e,
      client: { client_id: 'cli-client', redirect_uris: ['http://127.0.0.1:1/callback'], issuer: `${base}/` } as never,
      tokens: { access_token: 'expired', token_type: 'Bearer', refresh_token: 'revoked', issuer: `${base}/` } as never,
    }));
    const error = (await creditsCommand(ctx()).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe('Your session has expired. Run `aitopia login`.');
    expect(registered).toHaveLength(0);
  });
});

const fail_ = (e: unknown) => e as CliError;
const writeBatch = (items: unknown, name = 'batch.json') => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(items));
  return path;
};

describe('progress, dry runs and new error codes', () => {
  it('shows the server progress message in the spinner on a TTY (without its own seconds counter)', async () => {
    progressDelayMs = 300;
    await imageCommand(ctx(false, { tty: true }), ['fox'], { model: 'google/nano-banana-2', output: `${join(dir, 'o')}/` });
    expect(calls[0]?.progressToken).toBeDefined();
    expect(stderr.text).toContain('Generating image with Nano Banana 2');
    expect(stderr.text).not.toContain('Nano Banana 2 — 3 s');
    expect(stdout.text).toContain('Saved');
  });

  it('--json --verbose: progress lines go to stderr, stdout holds one JSON object', async () => {
    await imageCommand(ctx(true, { verbose: true }), ['fox'], { model: 'google/nano-banana-2', output: `${join(dir, 'o')}/` });
    expect(stderr.text).toContain('progress: Generating image with Nano Banana 2');
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'completed' });
  });

  it('no progress lines off a TTY without --verbose', async () => {
    await imageCommand(ctx(), ['fox'], { model: 'google/nano-banana-2', output: `${join(dir, 'o')}/` });
    expect(stderr.text).not.toContain('Nano Banana');
  });

  it('image --dry-run prices the call and never submits it', async () => {
    await imageCommand(ctx(), ['fox'], { model: 'google/nano-banana-2', count: 2, dryRun: true });
    expect(calls.map((c) => c.name)).toEqual(['generate_image']);
    expect(calls[0]?.args).toMatchObject({ dryRun: true, count: 2 });
    expect(stdout.text).toContain('Estimate: 8 credits');
    expect(stdout.text).toContain('Basis: 2 images x 4 credits.');
    expect(stdout.text).toContain('Balance: 8,951 credits available');
    expect(stdout.text).toContain('Affordable: yes');
    expect(stdout.text).toContain('Nothing was submitted or charged.');
  });

  it('--dry-run with a short balance says so plainly and still exits 0', async () => {
    balance = 3;
    await imageCommand(ctx(), ['fox'], { model: 'google/nano-banana-2', dryRun: true });
    expect(stdout.text).toContain('Affordable: no, not enough credits');
    expect(stdout.text).toContain('Buy credits: https://aitopia.ai/pricing');
  });

  it('--dry-run --json prints the estimate object', async () => {
    await imageCommand(ctx(true), ['fox'], { model: 'google/nano-banana-2', dryRun: true });
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'estimate', credits: 4, affordable: true, balance: { creditsForGeneration: 8951 } });
  });

  it('video --dry-run does not upload a local start image and sends dryRun to run_model', async () => {
    const image = join(dir, 'fox.png');
    writeFileSync(image, 'tiny png');
    await videoCommand(ctx(), ['the', 'fox', 'blinks'], { image, model: 'acme/i2v', dryRun: true });
    expect(calls.map((c) => c.name)).toEqual(['get_model_schema', 'run_model']);
    expect(calls[1]?.args).toMatchObject({ dryRun: true, input: { start_image_url: 'https://example.invalid/start-image' } });
    expect(stdout.text).toContain('Estimate: 50 credits');
  });

  it('PRICE_UNKNOWN exits 1 with a CLI hint', async () => {
    const error = fail_(await videoCommand(ctx(), ['waves'], { model: 'acme/unpriced', dryRun: true }).catch((e: unknown) => e));
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('PRICE_UNKNOWN');
    expect(error.hint).toBe('Run it without --dry-run only if you accept an unknown price.');
  });

  it('run --dry-run refuses a tool without a price check before calling it', async () => {
    const error = fail_(await runCommand(ctx(), 'create_product', { set: ['title=Mug'], dryRun: true }).catch((e: unknown) => e));
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('create_product has no price check');
    expect(calls).toEqual([]);
  });

  it('run --dry-run works for a tool that declares dryRun', async () => {
    await runCommand(ctx(true), 'generate_image', { jsonArgs: '{"prompt":"fox","selectedModelId":"google/nano-banana-2"}', dryRun: true });
    expect(calls[0]?.args).toMatchObject({ dryRun: true });
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'estimate' });
  });

  it('MODEL_NOT_FOUND prints the suggestions and a CLI hint', async () => {
    const error = fail_(await imageCommand(ctx(), ['fox'], { model: 'google/nano-banana-99' }).catch((e: unknown) => e));
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('MODEL_NOT_FOUND');
    expect(error.notes).toContain('Did you mean: google/nano-banana-2 (Nano Banana 2)');
    expect(error.hint).toBe('List models with `aitopia models --type image` and use an id it shows. Nothing was spent.');
  });
});

describe('status', () => {
  it('several tokens: one long-poll call with runTokens, downloads each finished run', async () => {
    runStates = {
      a: [{ status: 'completed', assetUrl: `${base}/files/a.png`, assetName: 'Red Fox' }],
      b: [{ status: 'running', etaSeconds: 5 }, { status: 'completed', assetUrl: `${base}/files/b.mp4`, assetName: 'Fox Clip' }],
    };
    const out = join(dir, 'runs');
    await statusCommand(ctx(true), ['a', 'b'], { wait: true, output: out });
    expect(calls.map((c) => c.args)).toEqual([
      { runTokens: ['a', 'b'], wait: 20 },
      { runTokens: ['b'], wait: 20 },
    ]);
    expect(readdirSync(out).sort()).toEqual(['fox-clip-2.mp4', 'red-fox-1.png']);
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'completed', total: 2, completed: 2 });
  }, 15_000);

  it('several tokens without --wait: checks once (wait 0) and reports runs still going (exit 0)', async () => {
    runStates = { a: [{ status: 'running', progress: 40 }], b: [{ status: 'completed', assetUrl: `${base}/files/b.png` }] };
    await statusCommand(ctx(), ['a', 'b'], { output: `${join(dir, 's')}/` });
    expect(calls.map((c) => c.args)).toEqual([{ runTokens: ['a', 'b'], wait: 0 }]);
    expect(stdout.text).toContain('run 1: still running (40%)');
    expect(stdout.text).toContain('Wait for it with: aitopia status a --wait');
  });

  it('an invalid token among several fails that run only (exit 1)', async () => {
    runStates = { a: [{ status: 'completed', assetUrl: `${base}/files/a.png` }] };
    const error = fail_(await statusCommand(ctx(), ['a', 'zzz'], { wait: true, output: `${join(dir, 's')}/` }).catch((e: unknown) => e));
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('INVALID_RUN_TOKEN');
    expect(stderr.text).toContain('This run token is not valid.');
    expect(readdirSync(join(dir, 's'))).toHaveLength(1);
  });

  it('one invalid token: clear message, exit 1', async () => {
    const error = fail_(await statusCommand(ctx(), ['nope'], {}).catch((e: unknown) => e));
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe('This run token is not valid.');
    expect(error.hint).toContain('expire after 7 days');
  });

  it('RUN_STALE: exit 1 with the creations link', async () => {
    runStates = {
      old: [
        {
          status: 'failed',
          code: 'RUN_STALE',
          retryable: false,
          error: 'This run has not finished 2 hours after it started; it will not be checked any further.',
          modelId: 'acme/i2v',
          details: { jobId: 'job-9', openInAitopia: 'https://aitopia.ai/creations' },
        },
      ],
    };
    const error = fail_(await statusCommand(ctx(), ['old'], { wait: true }).catch((e: unknown) => e));
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('RUN_STALE');
    expect(error.notes).toContain('Open in AITOPIA: https://aitopia.ai/creations');
    expect(calls).toHaveLength(1);
  });

  it('more than 12 tokens is a usage error', async () => {
    const tokens = Array.from({ length: 13 }, (_, i) => `t${i}`);
    expect(fail_(await statusCommand(ctx(), tokens, {}).catch((e: unknown) => e)).exitCode).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('batch', () => {
  const items = [
    { kind: 'image', prompt: 'a red fox in snow', modelId: 'google/nano-banana-2' },
    { kind: 'image', prompt: 'a paper boat', modelId: 'google/nano-banana-2', assetName: 'Boat Shot' },
    { kind: 'video', prompt: 'the fox turns its head', modelId: 'acme/i2v' },
  ];

  it('submits once, saves finished items at once, polls the rest with runTokens and saves them too', async () => {
    const out = join(dir, 'shots');
    await batchCommand(ctx(true), writeBatch({ items }), { output: out });
    expect(calls.map((c) => c.name)).toEqual(['generate_batch', 'get_run_status']);
    expect(calls[0]?.args).toMatchObject({ wait: 20 });
    expect(calls[0]?.progressToken).toBeDefined();
    expect((calls[0]?.args.items as unknown[]).length).toBe(3);
    expect(calls[1]?.args).toEqual({ runTokens: ['vid-2'], wait: 20 });
    expect(readdirSync(out).sort()).toEqual(['a-red-fox-in-snow-1.png', 'boat-shot-2.png', 'the-fox-turns-its-head-3.mp4']);
    const summary = JSON.parse(stdout.text) as { status: string; items: Array<{ status: string; files: string[] }> };
    expect(summary.status).toBe('completed');
    expect(summary.items.every((i) => i.status === 'completed' && i.files.length === 1)).toBe(true);
  }, 15_000);

  it('a SLOT_TIMEOUT item: exit 1, nothing-charged hint, the others still saved', async () => {
    const out = join(dir, 'p');
    const error = fail_(
      await batchCommand(ctx(), writeBatch([items[0], { kind: 'image', prompt: 'late', modelId: 'slow/x' }]), { output: out }).catch((e: unknown) => e),
    );
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('SLOT_TIMEOUT');
    expect(error.message).toBe('1 of 2 items finished, 1 failed.');
    expect(error.hint).toContain('safe to run them again');
    expect(error.data.status).toBe('partial');
    expect(readdirSync(out)).toEqual(['a-red-fox-in-snow-1.png']);
    expect(stderr.text).toContain('Failed: item 2 (image, slow/x)');
  });

  it('every item refused: exit 1 with the suggestions per item', async () => {
    const error = fail_(await batchCommand(ctx(), writeBatch([{ kind: 'image', prompt: 'x', modelId: 'nope/x' }]), {}).catch((e: unknown) => e));
    expect(error.exitCode).toBe(1);
    expect(error.data.status).toBe('failed');
    expect(stderr.text).toContain('Did you mean: google/nano-banana-2 (Nano Banana 2)');
  });

  it('BATCH_UNAVAILABLE: exit 1, nothing was charged', async () => {
    batchUnavailable = true;
    const error = fail_(await batchCommand(ctx(), writeBatch(items), {}).catch((e: unknown) => e));
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('BATCH_UNAVAILABLE');
    expect(error.hint).toBe('Nothing was submitted or charged; it is safe to run it again.');
  });

  it('--no-wait: saves what finished, exits 5 naming the runs still going', async () => {
    const out = join(dir, 'nw');
    const error = fail_(await batchCommand(ctx(), writeBatch(items), { output: out, wait: false }).catch((e: unknown) => e));
    expect(calls.map((c) => c.name)).toEqual(['generate_batch']);
    expect(calls[0]?.args).toMatchObject({ wait: 0 });
    expect(error.exitCode).toBe(5);
    expect(error.notes).toContain('Check it with: aitopia status vid-2 --wait');
    expect(readdirSync(out)).toHaveLength(2);
  });

  it('--dry-run: per-item prices and the total, nothing submitted', async () => {
    await batchCommand(ctx(), writeBatch(items), { dryRun: true });
    expect(calls.map((c) => c.name)).toEqual(['generate_batch', 'get_credit_balance']);
    expect(calls[0]?.args).toMatchObject({ dryRun: true });
    expect(stdout.text).toMatch(/3\s+video\s+acme\/i2v\s+50/);
    expect(stdout.text).toContain('Total: 58 credits');
    expect(stdout.text).toContain('Balance: 8,951 credits available');
    expect(stdout.text).toContain('Nothing was submitted or charged.');
  });

  it('--dry-run with an item that would be refused exits 1 and shows suggestions', async () => {
    const error = fail_(await batchCommand(ctx(), writeBatch([items[0], { kind: 'image', prompt: 'x', modelId: 'nope/x' }]), { dryRun: true }).catch((e: unknown) => e));
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('MODEL_NOT_FOUND');
    expect(stdout.text).toContain('item 2: did you mean: google/nano-banana-2 (Nano Banana 2)');
    expect(calls.filter((c) => c.name === 'generate_batch').every((c) => c.args.dryRun === true)).toBe(true);
  });

  it('uploads local files named in URL fields first (relative to the batch file), once each', async () => {
    writeFileSync(join(dir, 'ref.png'), 'png');
    const file = writeBatch([
      { kind: 'video', prompt: 'move', modelId: 'acme/i2v', input: { start_image_url: './ref.png' } },
      { kind: 'image', prompt: 'edit', modelId: 'google/nano-banana-2', input: { image_urls: ['ref.png', 'https://cdn.aitopia.ai/x.png'] } },
    ]);
    await batchCommand(ctx(true), file, { output: join(dir, 'u') });
    expect(calls.filter((c) => c.name === 'upload_asset')).toHaveLength(1);
    const sent = calls.find((c) => c.name === 'generate_batch')?.args.items as Array<{ input: Record<string, unknown> }>;
    expect(sent[0]?.input.start_image_url).toBe('https://cdn.aitopia.ai/uploaded.png');
    expect(sent[1]?.input.image_urls).toEqual(['https://cdn.aitopia.ai/uploaded.png', 'https://cdn.aitopia.ai/x.png']);
  }, 15_000);

  it('validates the file before connecting', async () => {
    const thirteen = Array.from({ length: 13 }, () => items[0]);
    expect(fail_(await batchCommand(ctx(), writeBatch(thirteen), {}).catch((e: unknown) => e)).exitCode).toBe(2);
    expect(fail_(await batchCommand(ctx(), writeBatch([{ kind: 'gif', prompt: 'x', modelId: 'm' }]), {}).catch((e: unknown) => e)).message).toBe(
      'Item 1: kind must be image, audio or video.',
    );
    expect(fail_(await batchCommand(ctx(), writeBatch([{ kind: 'image', prompt: 'x', modelID: 'm' }]), {}).catch((e: unknown) => e)).message).toContain(
      'unknown field modelID',
    );
    expect(fail_(await batchCommand(ctx(), writeBatch([{ kind: 'image', prompt: 'x', modelId: 'm', input: { image_url: 'missing.png' } }]), {}).catch((e: unknown) => e)).message).toContain(
      'Item 1, image_url: Cannot read',
    );
    expect(calls).toEqual([]);
  });
});

describe('review fixes', () => {
  const items = [
    { kind: 'image', prompt: 'a red fox in snow', modelId: 'google/nano-banana-2' },
    { kind: 'image', prompt: 'a paper boat', modelId: 'google/nano-banana-2' },
    { kind: 'video', prompt: 'the fox turns its head', modelId: 'acme/i2v' },
  ];

  it('Ctrl+C lists finished results that were not downloaded (human and --json)', async () => {
    brokenFiles = true;
    await batchCommand(ctx(), writeBatch(items), { output: join(dir, 'x') }).catch(() => undefined);
    const context = ctx();
    reportInterrupt(context.out);
    expect(stderr.text).toContain('Finished results (already paid for, do not generate them again):');
    expect(stderr.text).toContain(`item 1: Server Name 1 ${base}/files/batch-0.png`);
    expect(stderr.text).toContain(`item 3: Server Video Name ${base}/files/vid-2.mp4`);
    const jsonCtx = ctx(true);
    reportInterrupt(jsonCtx.out);
    const parsed = JSON.parse(stdout.text) as { status: string; ready: Array<{ assetUrl: string; file?: string }> };
    expect(parsed.status).toBe('interrupted');
    expect(parsed.ready.map((r) => r.assetUrl)).toContain(`${base}/files/batch-1.png`);
  }, 15_000);

  it('Ctrl+C after a download names the saved file', async () => {
    await imageCommand(ctx(), ['fox'], { model: 'google/nano-banana-2', output: `${join(dir, 'o')}/` });
    const context = ctx();
    reportInterrupt(context.out);
    expect(stderr.text).toContain(`saved ${join(dir, 'o', 'fox.png')}`);
  });

  it('an item with several files saves base-N-k, never overwriting one with --force', async () => {
    const out = join(dir, 'multi');
    await batchCommand(ctx(), writeBatch([items[0], { kind: 'image', prompt: 'two shots', modelId: 'multi/x' }]), { output: out, force: true });
    expect(readdirSync(out).sort()).toEqual(['a-red-fox-in-snow-1.png', 'two-shots-2-1.png', 'two-shots-2-2.png']);
  });

  it('status a b without --wait: no answer (rate limit) is exit 5, not "still running"', async () => {
    const error = fail_(await statusCommand(ctx(), ['a', 'limited'], {}).catch((e: unknown) => e));
    expect(error.exitCode).toBe(5);
    expect(stderr.text).toContain('run 1: AITOPIA did not answer for this run.');
    expect(stdout.text).not.toContain('still running');
  });

  it('batch items short of credits: "needs X credits" shown, exit 4', async () => {
    const error = fail_(await batchCommand(ctx(), writeBatch([{ kind: 'image', prompt: 'x', modelId: 'poor/x' }]), {}).catch((e: unknown) => e));
    expect(error.exitCode).toBe(4);
    expect(stderr.text).toContain('This run needs 40, you have 3 credits.');
  });

  it('multi-status items follow runsToResult (an unusual body status reads completed)', async () => {
    runStates = { a: [{ status: 'succeeded', assetUrl: `${base}/files/a.png` }], b: [{ status: 'completed', assetUrl: `${base}/files/b.png` }] };
    await statusCommand(ctx(true), ['a', 'b'], { wait: true, output: join(dir, 'r') });
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'completed', completed: 2 });
  });

  it('--verbose shows a waitNote from the server', async () => {
    const note = '3 waiting status checks are already open for your account, so this one checked once without waiting. Poll again after pollAfterMs.';
    waitNoteOnce = note;
    runStates = { a: [{ status: 'running' }, { status: 'completed', assetUrl: `${base}/files/a.png` }], b: [{ status: 'completed', assetUrl: `${base}/files/b.png` }] };
    await statusCommand(ctx(false, { verbose: true }), ['a', 'b'], { wait: true, output: join(dir, 'w') });
    expect(stderr.text).toContain('3 waiting status checks are already open');
  }, 15_000);

  it('batch --dry-run with a refused item keeps status "dry_run" in --json (exit 1)', async () => {
    const error = fail_(await batchCommand(ctx(true), writeBatch([items[0], { kind: 'image', prompt: 'x', modelId: 'nope/x' }]), { dryRun: true }).catch((e: unknown) => e));
    expect(error.exitCode).toBe(1);
    expect(jsonStatus(error)).toBe('dry_run');
  });

  it('the waiting line counts only the items still running', async () => {
    await batchCommand(ctx(false, { tty: true }), writeBatch(items), { output: join(dir, 'c') });
    expect(stderr.text).toContain('Waiting for 1 of 3');
    expect(stderr.text).not.toContain('Waiting for 3');
  }, 15_000);
});
