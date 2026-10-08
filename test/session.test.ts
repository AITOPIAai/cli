import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { CliError, failureToError } from '../src/errors.js';
import { clearReadyResults, reportInterrupt } from '../src/interrupt.js';
import { buildProgram, jsonStatus, printError } from '../src/cli.js';
import { batchCommand } from '../src/commands/batch.js';
import { runCommand } from '../src/commands/run.js';
import { statusCommand } from '../src/commands/status.js';
import { editCommand, shellWord } from '../src/commands/edit.js';
import { audioCommand } from '../src/commands/audio.js';
import {
  projectsCreateCommand,
  projectsDeleteCommand,
  projectsListCommand,
  projectsMoveCommand,
  projectsShowCommand,
} from '../src/commands/projects.js';
import { voicesCreateCommand, voicesDeleteCommand, voicesListCommand } from '../src/commands/voices.js';
import { transcribeCommand } from '../src/commands/transcribe.js';
import { analyzeCommand, renderAnalysis } from '../src/commands/analyze.js';
import { agentRunCommand, agentShowCommand, agentsCommand, DRY_RUN_FILE_URL } from '../src/commands/agents.js';
import { motionCommand, outpaintCommand, reframeCommand, removeBgCommand, upscaleCommand, voiceChangeCommand } from '../src/commands/named.js';
import { matchNamed } from '../src/resolve.js';
import { buildSrt, cuesFromWords, cuesOf, normalizeLanguage, splitSegment, sttModelFor, wrapCue } from '../src/transcript.js';

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
/** Set: get_credit_balance and dryRun estimates carry this runLimit (the Marketplace's normalized shape). */
let balanceRunLimit: Record<string, unknown> | undefined;
/** Set: generate_image (a real run with a model) fails with this body. */
let imageFailure: Record<string, unknown> | undefined;

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
    ...(balanceRunLimit ? { runLimit: balanceRunLimit } : {}),
    note: 'Estimate only: nothing was submitted, reserved or charged. Run the same call without dryRun to start it.',
    ...(affordable ? {} : { buyCreditsUrl: 'https://aitopia.ai/pricing', hint: 'Do not start it.' }),
  });
};

const SUSPENDED_TEXT = 'Your access to generation has been suspended.\nIf you believe this is a mistake, contact info@aitopia.ai.';

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
    if (item.modelId === 'banned/x') {
      return { ...head, status: 'failed', code: 'RUN_LIMITED', upstreamCode: 'QUEUE_LIMIT_EXCEEDED', reason: 'abuse_limit', error: SUSPENDED_TEXT, retryable: false, upgrade: false };
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

// edit_media (scotty src/mcp edit-media): a planned chain of model / agent /
// ffmpeg steps, index 1..n. Instructions steer the fake: "planner down" ->
// PLAN_UNAVAILABLE, "break" -> step 2 fails mid-chain (a non-error
// {status:"partial"}), "inline" -> finishes in the first answer; anything
// else runs in the background as edit-1 and is polled.
const EDIT_STEPS = [
  { kind: 'model', id: 'bria/remove-background', displayName: 'Bria Remove Background', why: 'Cuts the subject out cleanly.', credits: 2, basis: '1 image x 2 credits.' },
  { kind: 'model', id: 'topaz/image-upscale', displayName: 'Topaz Image Upscale', why: 'Sharpens it to 4K.', credits: 4, basis: '1 image at 4K x 4 credits.' },
  { kind: 'ffmpeg', id: 'resize', displayName: 'Resize', why: 'Pads it to 9:16 for a story.', credits: 0, basis: 'Editing tools are free.' },
];
const EDIT_SUMMARY = 'Remove the background, upscale to 4K, then pad to 9:16.';
const EDIT_TOTAL = 6;
const stepUrl = (n: number) => `${base}/files/edit-step-${n}.png`;

function editPlan(statuses: string[] = []) {
  return {
    summary: EDIT_SUMMARY,
    steps: EDIT_STEPS.map((step, i) => {
      const status = statuses[i];
      return {
        index: i + 1,
        ...step,
        ...(status ? { status } : {}),
        ...(status === 'completed' ? { assetUrl: stepUrl(i + 1), assetName: `Fox step ${i + 1}`, creationUrl: `https://aitopia.ai/creations/s${i + 1}` } : {}),
      };
    }),
  };
}

const EDIT_DONE = () => ({
  status: 'completed',
  assetUrl: stepUrl(3),
  assetName: 'Fox story',
  creationUrl: 'https://aitopia.ai/creations/e1',
  mediaType: 'image',
  plan: editPlan(['completed', 'completed', 'completed']),
  totalCredits: EDIT_TOTAL,
  openInAitopia: 'https://aitopia.ai/c/e1',
});

const EDIT_PARTIAL = () => ({
  status: 'partial',
  code: 'UPSTREAM_ERROR',
  error: 'Topaz Image Upscale could not process this image.',
  failedStep: 2,
  retryable: false,
  lastAssetUrl: stepUrl(1),
  items: [{ index: 1, status: 'completed', kind: 'model', id: 'bria/remove-background', assetUrl: stepUrl(1), assetName: 'Fox step 1', creationUrl: 'https://aitopia.ai/creations/s1' }],
  plan: editPlan(['completed', 'failed', 'skipped']),
  totalCredits: 2,
  openInAitopia: 'https://aitopia.ai/c/e2',
  note: 'Step 1 finished and is saved in AITOPIA; nothing after step 2 ran.',
});

function editMedia(args: Record<string, unknown>) {
  const instruction = String(args.instruction ?? '');
  if (typeof args.assetUrl !== 'string' || !args.assetUrl) return fail({ code: 'INVALID_INPUT', error: 'assetUrl is required.', retryable: false });
  if (instruction.includes('planner down')) {
    return fail({ code: 'PLAN_UNAVAILABLE', error: 'The edit planner is not available right now. Nothing was spent.', retryable: true });
  }
  if (instruction.includes('rate store down')) {
    return fail({ code: 'PLAN_UNAVAILABLE', error: 'Edits are unavailable right now (the rate store is down). Nothing was spent.', retryable: true });
  }
  if (instruction.includes('unknown price')) {
    // With or without maxCredits / dryRun: the plan comes back, nothing runs.
    const plan = editPlan();
    plan.steps[1] = { ...plan.steps[1], credits: null as unknown as number } as (typeof plan.steps)[number];
    return fail({ code: 'PRICE_UNKNOWN', error: 'Topaz Image Upscale lists no price, so this edit cannot be priced. Nothing ran.', retryable: false, details: { plan } });
  }
  const maxCredits = typeof args.maxCredits === 'number' ? args.maxCredits : undefined;
  if (instruction.includes('already')) {
    const plan = editPlan(['completed']);
    return ok({
      ...EDIT_DONE(),
      assetUrl: stepUrl(1),
      noTransformNeeded: true,
      plan: { ...plan, steps: plan.steps.slice(0, 1).map((st) => ({ ...st, id: 'resize', kind: 'ffmpeg', displayName: 'Resize', credits: 0, unchanged: true })) },
      totalCredits: 0,
    });
  }
  if (args.dryRun === true) {
    const affordable = balance >= EDIT_TOTAL;
    const estimate = {
      status: 'estimate',
      dryRun: true,
      mediaType: 'image',
      plan: instruction.includes('estimated')
        ? { ...editPlan(), steps: editPlan().steps.map((st) => (st.index === 2 ? { ...st, creditsEstimated: true } : st)) }
        : editPlan(),
      totalCredits: EDIT_TOTAL,
      complete: true,
      balance: { creditsForGeneration: balance, ...(balanceRunLimit ? { runLimit: balanceRunLimit } : {}) },
      affordable,
      ...(affordable ? {} : { buyCreditsUrl: 'https://aitopia.ai/pricing', hint: 'Do not start it.' }),
      ...(maxCredits !== undefined ? { maxCredits, withinBudget: EDIT_TOTAL <= maxCredits } : {}),
      planToken: 'plan-token-abcdefghijkl',
      planTokenExpiresInSec: 3600,
      note: 'Estimate only: nothing was submitted, reserved or charged.',
    };
    // Planning took longer than the inline wait: the estimate comes through the run token.
    if (instruction.includes('slow plan')) {
      runStates['edit-plan'] ??= [{ status: 'running', tool: 'edit_media', runToken: 'edit-plan', pollAfterMs: 2000 }, estimate];
      return ok({ status: 'running', tool: 'edit_media', runToken: 'edit-plan', pollAfterMs: 2000 });
    }
    return ok(estimate);
  }
  if (args.planToken !== undefined && args.planToken !== 'plan-token-abcdefghijkl') {
    return fail({ code: 'PLAN_EXPIRED', error: 'The planToken has expired. Nothing was run or charged; run a new dryRun.', retryable: false });
  }
  if (maxCredits !== undefined && maxCredits < EDIT_TOTAL) {
    return fail({
      code: 'OVER_BUDGET',
      error: `The plan costs ${EDIT_TOTAL} credits, more than maxCredits (${maxCredits}). Nothing ran.`,
      retryable: false,
      details: { plan: editPlan(), totalCredits: EDIT_TOTAL, maxCredits },
    });
  }
  if (instruction.includes('inline')) return ok(EDIT_DONE());
  if (instruction.includes('poll fails')) {
    // The provider could not be checked 10 times in a row (hard failure via get_run_status).
    runStates['edit-poll'] ??= [{ status: 'failed', code: 'POLL_FAILED', error: 'Topaz Image Upscale could not be checked 10 times in a row; it may still finish.', retryable: false, details: { failedStep: 2 } }];
    return ok({ status: 'running', tool: 'edit_media', runToken: 'edit-poll', pollAfterMs: 2000 });
  }
  if (instruction.includes('poll partial')) {
    return ok({ ...EDIT_PARTIAL(), code: 'POLL_FAILED', error: 'The provider could not be checked 10 times in a row; the step may still finish.' });
  }
  const runToken = instruction.includes('break') ? 'edit-broken' : 'edit-1';
  runStates[runToken] ??= [{ status: 'running', tool: 'edit_media', runToken, pollAfterMs: 2000, progress: 40 }, instruction.includes('break') ? { ...EDIT_PARTIAL(), ...(instruction.includes('credits') ? { code: 'INSUFFICIENT_CREDITS', error: 'Not enough credits for step 2.' } : {}) } : EDIT_DONE()];
  return ok({ status: 'running', tool: 'edit_media', runToken, pollAfterMs: 2000 });
}

// Projects (scotty src/mcp/project-tool-executor.ts), voices (voice-tools.ts,
// lib/voices/service.ts), audio_tools and the speech-to-text models run with
// run_model. list_projects pages by 3 here so that name lookups must page.
type FakeProject = { id: string; name: string; assetCount: number; folders: Array<{ id: string; name: string; parentFolderId: string | null }> };
let projectsDb: FakeProject[] = [];
let voicesDb: Array<Record<string, unknown>> = [];
const GROK_WORDS = [
  { text: 'Hello', start: 0.1, end: 0.4 },
  { text: 'there.', start: 0.45, end: 0.8 },
  { text: 'This', start: 1.0, end: 1.2 },
  { text: 'is', start: 1.25, end: 1.35 },
  { text: 'a', start: 1.4, end: 1.45 },
  { text: 'test', start: 1.5, end: 1.8 },
  // a pause of more than 0.6 s starts a new cue
  { text: 'after', start: 2.6, end: 2.9 },
  { text: 'a', start: 2.95, end: 3.0 },
  { text: 'pause', start: 3.05, end: 3.5 },
];
const WHISPER_SRT = '1\n00:00:00,000 --> 00:00:02,000\nHabari ya asubuhi.\n\n2\n00:00:02,000 --> 00:00:05,000\nKaribu sana.\n';

function newTools(name: string, args: Record<string, unknown>) {
  const project = () => projectsDb.find((p) => p.id === args.projectId);
  switch (name) {
    case 'list_projects': {
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const size = Math.min(typeof args.limit === 'number' ? args.limit : 30, 3);
      const page = projectsDb.slice(offset, offset + size);
      return ok({
        status: 'completed',
        projects: page.map((p) => ({ id: p.id, name: p.name, description: null, assetCount: p.assetCount, openInAitopia: `https://aitopia.ai/creations?project=${p.id}` })),
        total: projectsDb.length,
        ...(offset + page.length < projectsDb.length ? { nextOffset: offset + page.length } : {}),
        openInAitopia: 'https://aitopia.ai/creations',
      });
    }
    case 'create_project': {
      if (projectsDb.some((p) => p.name === args.name)) return fail({ code: 'NAME_CONFLICT', error: `A project named "${String(args.name)}" already exists.`, retryable: false });
      const created = { id: 'p-new', name: String(args.name), assetCount: 0, folders: [] };
      projectsDb.push(created);
      return ok({ status: 'completed', project: { id: created.id, name: created.name, assetCount: 0 }, openInAitopia: 'https://aitopia.ai/creations?project=p-new' });
    }
    case 'list_project_assets': {
      const p = project();
      if (!p) return fail({ code: 'PROJECT_NOT_FOUND', error: 'Project not found. Use list_projects to see the user\'s projects.', retryable: false });
      const assets = [
        { id: 'a-1', name: 'Fox banner', mediaType: 'image', assetUrl: 'https://cdn.aitopia.ai/fox.png', folderId: 'f-1', createdAt: '2026-10-01T10:00:00.000Z' },
        { id: 'a-2', name: 'Teaser', mediaType: 'video', assetUrl: 'https://cdn.aitopia.ai/teaser.mp4', folderId: null, createdAt: '2026-10-02T10:00:00.000Z' },
      ].filter((a) => (args.folderId ? a.folderId === args.folderId : true) && (args.mediaType ? a.mediaType === args.mediaType : true));
      return ok({ status: 'completed', project: { id: p.id, name: p.name }, folders: p.folders, assets, total: assets.length, openInAitopia: `https://aitopia.ai/creations?project=${p.id}` });
    }
    case 'move_assets': {
      const urls = (args.assetUrls as string[] | undefined) ?? [];
      const ids = (args.assetIds as string[] | undefined) ?? [];
      const missing = [...urls.filter((u) => u.includes('missing')), ...ids.filter((i) => i.includes('missing'))];
      const moved = [...urls, ...ids].filter((x) => !missing.includes(x)).map((x, i) => ({ id: `m-${i}`, name: 'file', assetUrl: x }));
      const p = typeof args.projectId === 'string' ? project() : undefined;
      return ok({ status: 'completed', moved: moved.length, assets: moved, ...(missing.length ? { notFound: missing } : {}), project: p ? { id: p.id, name: p.name } : null, openInAitopia: 'https://aitopia.ai/creations' });
    }
    case 'delete_project': {
      const p = project();
      if (!p) return fail({ code: 'PROJECT_NOT_FOUND', error: 'Project not found.', retryable: false });
      projectsDb = projectsDb.filter((x) => x !== p);
      return ok({ status: 'completed', deleted: { id: p.id, name: p.name }, assetsKept: p.assetCount, note: 'The project and its folders were deleted.' });
    }
    case 'list_voices':
      return ok({ status: 'completed', voices: voicesDb });
    case 'probe_media': {
      const url = String(args.assetUrl);
      if (url.includes('long')) return ok({ status: 'completed', durationSec: 7300, hasVideo: false, hasAudio: true });
      if (url.includes('silent')) return ok({ status: 'completed', durationSec: 3, hasVideo: false, hasAudio: false });
      if (url.includes('still')) return ok({ status: 'completed', durationSec: 0.04, hasVideo: true, hasAudio: false, video: { codec: 'png', width: 800, height: 600 } });
      return ok({ status: 'completed', durationSec: 3.6, hasVideo: url.includes('video'), hasAudio: true });
    }
    case 'create_upload_link':
      if (typeof args.sourceUrl === 'string') return ok({ status: 'completed', assetUrl: 'https://cdn.aitopia.ai/imported-video' });
      return undefined;
    case 'create_voice': {
      if (args.consent !== true) return fail({ code: 'CONSENT_REQUIRED', error: 'consent is required.', retryable: false });
      if (args.dryRun === true) return estimate(150, '150 credits per voice clone.', 'fal-ai/minimax/voice-clone');
      const ready = (voiceId: string, voiceName: string, extra: Record<string, unknown> = {}) =>
        ok({ status: 'completed', voiceId, name: voiceName, state: 'ready', previewUrl: `${base}/files/voice-preview.mp3`, assetUrl: `${base}/files/voice-preview.mp3`, credits: 150, ...extra });
      if (typeof args.voiceId === 'string') {
        if (args.voiceId === 'v-slow') return ready('v-slow', 'Slow voice');
        const voice = voicesDb.find((v) => v.voiceId === args.voiceId);
        return voice ? ready(String(voice.voiceId), String(voice.name), { recreated: true }) : fail({ code: 'VOICE_NOT_FOUND', error: 'No voice with this voiceId in your voices.' });
      }
      if (typeof args.sampleUrl !== 'string' || !args.sampleUrl.startsWith('https://cdn.aitopia.ai/')) {
        return fail({ code: 'SAMPLE_NOT_OWNED', error: 'The recording must be a file the user uploaded to AITOPIA themselves. Nothing was run or charged.', retryable: false });
      }
      if (args.name === 'Taken') return fail({ code: 'VOICE_NAME_TAKEN', error: 'You already have a voice named "Taken".', retryable: false });
      // Still cloning: the voiceId (no runToken) is how it is finished.
      if (args.name === 'Slow voice') return ok({ status: 'running', state: 'cloning', voiceId: 'v-slow', name: 'Slow voice', pollAfterMs: 2000, note: 'The clone is still running.' });
      return ready('v-new', String(args.name));
    }
    case 'delete_voice': {
      const voice = voicesDb.find((v) => v.voiceId === args.voiceId);
      if (!voice) return fail({ code: 'VOICE_NOT_FOUND', error: 'No voice with this voiceId in your voices.', voiceId: args.voiceId });
      if (voice.state === 'cloning' && args.force !== true) {
        return fail({ code: 'VOICE_STILL_CLONING', error: `The voice "${String(voice.name)}" is still being cloned.`, voiceId: args.voiceId });
      }
      return ok({ status: 'completed', deleted: true, voiceId: args.voiceId });
    }
    case 'generate_audio': {
      // emotion maps onto MiniMax voice_setting.emotion; other models answer with a note.
      const emotionNote = args.emotion !== undefined && !args.voiceId ? { note: 'emotion is not supported by this model and was ignored.' } : {};
      if (args.dryRun === true && args.emotion !== undefined) {
        return ok({ status: 'estimate', credits: 15, basis: 'The listed price for this model (15 credits).', modelId: 'fal-ai/minimax/speech-2.8-hd', balance: { creditsForGeneration: balance }, affordable: true, note: 'Estimate only: nothing was submitted, reserved or charged.', ...emotionNote });
      }
      if (args.dryRun === true) return estimate(15, 'The listed price for this model (15 credits).', 'fal-ai/minimax/speech-2.8-hd');
      if (args.voiceId === 'v-1' && String(args.prompt).includes('expired')) {
        return fail({ code: 'VOICE_EXPIRED', error: 'The voice "My voice" is no longer available at the voice provider.', voiceId: 'v-1', recreateCredits: 150, hint: 'Do not retry the speech. Re-create the voice from the stored sample: create_voice with {voiceId: "v-1", consent: true}.' });
      }
      if (!args.voiceId && !args.selectedModelId) return fail({ code: 'MODEL_REQUIRED', error: 'Choose the audio model.', suggestions: [] });
      return ok({ status: 'completed', assetUrl: `${base}/files/speech.mp3`, assetName: 'Speech', modelId: args.voiceId ? 'fal-ai/minimax/speech-2.8-hd' : args.selectedModelId, ...emotionNote });
    }
    case 'audio_tools': {
      const input = args.input as Record<string, unknown>;
      if (args.dryRun === true) return ok({ status: 'estimate', credits: 1, basis: 'Fixed price for audio_tools: 1 credit per edit.', balance: { creditsForGeneration: balance }, affordable: true });
      if (input.operation !== 'extract') return fail({ code: 'INVALID_INPUT', error: 'unexpected operation' });
      return ok({ status: 'completed', assetUrl: 'https://cdn.aitopia.ai/extracted.mp3', assetName: 'talk audio' });
    }
    case 'run_model': {
      if (args.modelId === 'xai/grok-speech-to-text' && args.dryRun !== true) {
        return ok({ status: 'completed', modelId: args.modelId, jobId: 'stt-1', assetUrl: null, output: { duration: 3.6, language: 'en', text: 'Hello there. This is a test after a pause', words: GROK_WORDS } });
      }
      if (args.modelId === 'openai/whisper' && args.dryRun !== true) {
        return ok({ status: 'completed', modelId: args.modelId, jobId: 'stt-2', assetUrl: null, output: { detected_language: 'swahili', transcription: WHISPER_SRT, segments: [{ start: 0, end: 2, text: ' Habari ya asubuhi.' }, { start: 2, end: 5, text: ' Karibu sana.' }] } });
      }
      return undefined;
    }
    case 'list_store_agents': {
      const q = typeof args.q === 'string' ? args.q.toLowerCase() : '';
      const list = STORE_AGENTS.filter((a) => !q || [a.name, a.description, a.category].some((t) => String(t).toLowerCase().includes(q)));
      return ok({ totalAvailable: list.length, returned: list.length, agents: list });
    }
    case 'get_store_agent_schema': {
      const input = AGENT_SCHEMAS[String(args.agentId)];
      if (!input) return fail({ code: 'FAILED', error: 'Agent implementation not registered yet' });
      return ok({ agentId: args.agentId, input, output: { type: 'object', properties: { success: { type: 'boolean' }, output: { type: 'object' } } }, files: [] });
    }
    case 'run_store_agent':
      return runStoreAgent(args);
    default:
      return undefined;
  }
}

// list_store_agents / get_store_agent_schema / run_store_agent
// (marketplace-tool-executor.ts): x-uap widgets mark file fields; dryRun is the
// listed price; async agents answer a runToken polled with get_run_status.
const STORE_AGENTS = [
  { id: 'background-remover', name: 'Background Remover Pro', description: 'Upload any photo and get it back with the background removed.', category: 'higgsfield-image', async: false, estimatedDuration: { min: 0, max: 32 }, creditsEstimated: { min: 1, max: 1 }, modelChoices: [] },
  { id: 'video-upscaler', name: 'Video Upscaler (SeedVR2)', description: 'Upscale and enhance your videos.', category: 'higgsfield-video', async: true, estimatedDuration: { min: 0, max: 461 }, creditsEstimated: { min: 40, max: 40 }, modelChoices: [] },
  { id: 'smart-data-analyzer', name: 'Smart Data Analyzer', description: 'AI-powered data analysis.', category: 'analytics', async: true, estimatedDuration: { min: 5, max: 60 }, creditsEstimated: { min: 1, max: 5 }, modelChoices: [] },
  { id: 'image-generator', name: 'Image Generator', description: 'Images from text.', category: 'higgsfield-image', async: true, creditsEstimated: { min: 2, max: 2 }, modelChoices: [] },
  { id: 'viral-image-studio', name: 'Image Generator', description: 'Viral images.', category: 'higgsfield-image', async: false, creditsEstimated: { min: 3, max: 3 }, modelChoices: [] },
];
const AGENT_SCHEMAS: Record<string, Record<string, unknown>> = {
  'background-remover': {
    type: 'object',
    properties: { photo: { type: 'string', title: 'Your Photo', description: 'Upload the image whose background you want to remove.', 'x-uap': { ui_component: 'file-upload', widget: 'media', mediaKind: 'image' } } },
    required: ['photo'],
  },
  'video-upscaler': {
    type: 'object',
    properties: {
      video: { type: 'string', title: 'Source Video', 'x-uap': { ui_component: 'file-upload', widget: 'media', mediaKind: 'video' } },
      target_resolution: { type: 'string', default: '1080p', enum: ['720p', '1080p', '1440p', '2160p'], 'x-uap': { widget: 'select' } },
      noise_scale: { type: 'number', default: 0.1, minimum: 0, maximum: 1 },
    },
    required: ['video'],
  },
  'image-generator': { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
  'smart-data-analyzer': {
    type: 'object',
    properties: {
      data: { type: 'string', description: 'CSV data or JSON array as string', 'x-uap': { widget: 'textarea' } },
      format: { type: 'string', enum: ['csv', 'json'], default: 'csv' },
      hasHeaders: { type: 'boolean', default: true },
      rows: { type: 'integer' },
      notes: {},
      logo: { type: 'string', format: 'uri', description: 'Your logo image.' },
      website: { type: 'string', format: 'uri', description: 'Your web page.' },
    },
    required: ['data', 'format'],
  },
};

function runStoreAgent(args: Record<string, unknown>) {
  const agent = STORE_AGENTS.find((a) => a.id === args.agentId);
  if (!agent) return fail({ code: 'NOT_FOUND', error: `There is no store agent with the id "${String(args.agentId)}".`, agentId: args.agentId, retryable: false, hint: 'Call list_store_agents and use an id it returns.' });
  if (args.dryRun === true) {
    const { min, max } = agent.creditsEstimated;
    return ok({ status: 'estimate', credits: max, basis: `The listed price for this agent: ${max} credit${max === 1 ? '' : 's'}.`, agentId: agent.id, breakdown: { minCredits: min, maxCredits: max }, balance: { creditsForGeneration: balance }, affordable: balance >= max, note: 'Estimate only: nothing was submitted, reserved or charged.' });
  }
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (agent.id === 'background-remover') {
    if (typeof input.photo !== 'string' || !input.photo.startsWith('https://')) {
      return fail({ code: 'INVALID_INPUT', error: 'photo must be an https URL.', agentId: agent.id, retryable: false, owner: 'caller' });
    }
    return ok({ status: 'completed', state: 'completed', agentId: agent.id, jobId: 'aj-1', progress: 100, assetUrl: `${base}/files/cutout.png`, creationUrl: 'https://aitopia.ai/creations/a1', output: { url: `${base}/files/cutout.png` }, openInAitopia: 'https://aitopia.ai/c/a1' });
  }
  if (agent.id === 'smart-data-analyzer') {
    return ok({ status: 'completed', state: 'completed', agentId: agent.id, jobId: 'aj-2', progress: 100, assetId: null, assetUrl: null, output: { summary: { rowCount: 2, columnCount: 2 } } });
  }
  runStates['agent-1'] ??= [
    { status: 'running', agentId: agent.id, progress: 40, pollAfterMs: 2000 },
    { status: 'completed', agentId: agent.id, jobId: 'aj-3', progress: 100, assetUrl: `${base}/files/upscaled.mp4`, creationUrl: 'https://aitopia.ai/creations/a3', output: {}, openInAitopia: 'https://aitopia.ai/c/a3' },
  ];
  return ok({ status: 'running', agentId: agent.id, runToken: 'agent-1', pollAfterMs: 2000, poll: 'Call get_run_status with this runToken until status is completed or failed.' });
}

function tool(name: string, args: Record<string, unknown>) {
  const handled = newTools(name, args);
  if (handled) return handled;
  switch (name) {
    case 'get_run_status':
      return runStatus(args);
    case 'generate_batch':
      return generateBatch(args);
    case 'edit_media':
      return editMedia(args);
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
        ...(balanceRunLimit ? { runLimit: balanceRunLimit } : {}),
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
      if (imageFailure) return imageFailure.runLimit ? { content: [{ type: 'text', text: JSON.stringify(imageFailure) }], isError: true } : fail(imageFailure);
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
    case 'generate_video': {
      const modelId = typeof args.modelId === 'string' ? args.modelId : args.imageUrl ? 'acme/i2v' : 'bytedance/seedance-1-lite';
      if (args.duration === 7) {
        return fail({ code: 'INVALID_INPUT', field: 'duration', error: `${modelId} does not support duration 7. Allowed: 5, 10. Nothing was spent.`, retryable: false });
      }
      if (args.dryRun === true) {
        if (modelId === 'acme/unpriced') {
          return fail({ code: 'PRICE_UNKNOWN', error: 'This model lists no price, so it cannot be estimated before it runs. Nothing was spent.', retryable: false, modelId, hint: 'Run it without dryRun only if the user accepts an unknown price.' });
        }
        return estimate(50, '5 s x 10 credits per second at 720p.', modelId);
      }
      return ok({ status: 'running', modelId, jobId: 'job-1', runToken: 'run-1', progress: null, queuePosition: null, etaSeconds: null, pollAfterMs: 2000 });
    }
    case 'upscale_image':
    case 'upscale_video':
    case 'remove_background':
    case 'outpaint_image':
    case 'reframe':
    case 'motion_control':
    case 'voice_change': {
      const url = String(args.assetUrl ?? args.characterImageUrl);
      const video = name === 'upscale_video' || name === 'motion_control' || (name !== 'upscale_image' && /\.(mp4|mov)$/.test(url));
      const steps = name === 'voice_change' && /\.mp4$/.test(url)
        ? [
            { index: 1, kind: 'ffmpeg', id: 'audio_tools', displayName: 'Extract audio', credits: 1 },
            { index: 2, kind: 'model', id: 'elevenlabs/voice-changer', displayName: 'ElevenLabs Voice Changer', credits: 6 },
            { index: 3, kind: 'ffmpeg', id: 'mix_audio_layers', displayName: 'Put the audio back', credits: 1 },
          ]
        : [{ index: 1, kind: 'model', id: `pinned/${name}`, displayName: `Pinned ${name}`, credits: 8 }];
      const total = steps.reduce((sum, st) => sum + st.credits, 0);
      if (args.dryRun === true) {
        return ok({ status: 'estimate', dryRun: true, mediaType: video ? 'video' : 'image', plan: { summary: name, steps }, totalCredits: total, complete: true, balance: { creditsForGeneration: balance }, affordable: balance >= total, note: `Estimate only: nothing was run, reserved or charged. Call ${name} again without dryRun to run it.` });
      }
      if (url.includes('partial')) {
        return ok({ status: 'partial', code: 'UPSTREAM_FAILED', error: 'Step 3 failed: mux failed', failedStep: 3, lastAssetUrl: 'https://cdn.aitopia.ai/changed-voice.mp3', items: [], plan: { summary: name, steps }, totalCredits: 7 });
      }
      if (video) return ok({ status: 'running', runToken: 'run-1', progress: null, pollAfterMs: 2000 });
      return ok({ status: 'completed', assetUrl: `${base}/files/${name}.png`, assetName: 'result', mediaType: 'image', plan: { summary: name, steps }, totalCredits: total, openInAitopia: 'https://aitopia.ai/c/3' });
    }
    case 'analyze_media': {
      if (args.dryRun === true) return ok({ status: 'estimate', credits: 3, basis: '3 credits per output.', modelId: 'google/gemini-3.5-flash', mode: args.mode ?? 'summary', mediaType: 'video', balance: { creditsForGeneration: balance }, affordable: true });
      if (String(args.assetUrl).includes('unreachable')) return fail({ status: 'failed', code: 'UPSTREAM_HARD_FAILURE', error: '403 Forbidden for url', retryable: false });
      return ok({
        status: 'completed',
        mediaType: 'video',
        mode: args.mode ?? (args.question ? 'qa' : 'summary'),
        ...(args.question ? { answer: 'Yes, at 0:01.' } : {}),
        summary: 'A cat jumps on a sofa.',
        scenes: [{ start: 0, end: 2.5, description: 'Cat runs' }, { start: 2.5, end: 65, description: 'Cat jumps' }],
        onScreenText: ['SALE'],
        audio: 'upbeat music',
        modelId: 'google/gemini-3.5-flash',
        jobId: 'job-a',
      });
    }
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
    const editPoll = request.params.name === 'get_run_status' && String(args.runToken ?? '').startsWith('edit-');
    if (progressToken !== undefined && (request.params.name !== 'get_run_status' || editPoll)) {
      // tool-progress.ts: one at once, then every ~3 s with the elapsed seconds.
      const label =
        request.params.name === 'generate_batch'
          ? 'Running 3 generations'
          : request.params.name === 'edit_media'
            ? 'Step 1/3 · Removing the background with Bria Remove Background'
            : editPoll
              ? 'Step 2/3 · Upscaling with Topaz Image Upscale'
              : 'Generating image with Nano Banana 2';
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
  balanceRunLimit = undefined;
  imageFailure = undefined;
  brokenFiles = false;
  revocationEndpoint = '';
  revoked = [];
  registered = [];
  tokenRequests = [];
  rejectAll = false;
  projectsDb = [
    { id: 'p-1111', name: 'Podcast', assetCount: 0, folders: [] },
    { id: 'p-2222', name: 'Dup', assetCount: 1, folders: [] },
    { id: 'p-3333', name: 'dup', assetCount: 1, folders: [] },
    // On the second page of list_projects.
    {
      id: 'p-4444',
      name: 'Spring campaign',
      assetCount: 3,
      folders: [
        { id: 'f-1', name: 'Banners', parentFolderId: null },
        { id: 'f-2', name: 'Close-ups', parentFolderId: 'f-1' },
      ],
    },
  ];
  voicesDb = [
    { voiceId: 'v-1', name: 'My voice', state: 'ready', createdAt: '2026-09-01T10:00:00.000Z', lastUsedAt: null, mayHaveExpired: true },
    { voiceId: 'v-2', name: 'Cloning one', state: 'cloning', createdAt: '2026-10-01T10:00:00.000Z', lastUsedAt: null },
    { voiceId: 'v-3', name: 'Fresh', state: 'ready', createdAt: '2026-10-02T10:00:00.000Z', lastUsedAt: '2026-10-02T11:00:00.000Z' },
  ];
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

  it('video calls generate_video: uploads a local image, prints the model AITOPIA picked and polls to the result', async () => {
    const image = join(dir, 'fox.png');
    writeFileSync(image, 'tiny png');
    const out = join(dir, 'clips');
    await videoCommand(ctx(), ['the', 'fox', 'blinks'], { image, duration: '5', aspect: '9:16', resolution: '1080p', audio: false, output: `${out}/` });
    expect(calls.map((c) => c.name)).toEqual(['upload_asset', 'generate_video', 'get_run_status']);
    expect(calls[1]?.args).toEqual({
      prompt: 'the fox blinks',
      imageUrl: 'https://cdn.aitopia.ai/uploaded.png',
      duration: 5,
      aspectRatio: '9:16',
      resolution: '1080p',
      generateAudio: false,
    });
    // The paid call asks for live progress; the status check long-polls on the server.
    expect(calls[1]?.progressToken).toBeDefined();
    expect(calls[2]?.args).toEqual({ runToken: 'run-1', wait: 20 });
    expect(stderr.text).toContain('Model: acme/i2v');
    // Named after the prompt, not the provider's file id.
    expect(readdirSync(out)).toEqual(['the-fox-blinks.mp4']);
  }, 15_000);

  it('video --model passes modelId with allowAnyModel; a finished run with assetUrl null finds the file inside output', async () => {
    runOutput = { assetUrl: null, output: { video: { url: `${base}/files/nested.mp4` }, seed: 1 } };
    const out = join(dir, 'nested');
    await videoCommand(ctx(), ['waves'], { model: 'acme/i2v', audio: true, output: `${out}/` });
    expect(readdirSync(out)).toEqual(['waves.mp4']);
    expect(calls[0]?.args).toEqual({ prompt: 'waves', modelId: 'acme/i2v', allowAnyModel: true, generateAudio: true });
    expect(stderr.text).not.toContain('Model:');
  }, 15_000);

  it('video refuses --set and a bad --duration before connecting; a value the model lacks is the server\'s refusal', async () => {
    const set = await failure(videoCommand(ctx(), ['waves'], { set: ['seed=7'] }));
    expect(set?.exitCode).toBe(2);
    expect(set?.message).toContain('--set is not available for video');
    expect(set?.hint).toContain('aitopia run run_model');
    const bad = await failure(videoCommand(ctx(), ['waves'], { duration: 'long' }));
    expect(bad?.exitCode).toBe(2);
    expect(calls).toEqual([]);
    const refused = await failure(videoCommand(ctx(), ['waves'], { duration: '7' }));
    expect(refused?.exitCode).toBe(1);
    expect(refused?.code).toBe('INVALID_INPUT');
    expect(refused?.message).toContain('Allowed: 5, 10');
  });

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

  it('video --dry-run does not upload a local start image and sends dryRun to generate_video', async () => {
    const image = join(dir, 'fox.png');
    writeFileSync(image, 'tiny png');
    await videoCommand(ctx(), ['the', 'fox', 'blinks'], { image, model: 'acme/i2v', dryRun: true });
    expect(calls.map((c) => c.name)).toEqual(['generate_video']);
    expect(calls[0]?.args).toMatchObject({ dryRun: true, imageUrl: 'https://example.invalid/start-image' });
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

describe('edit', () => {
  const photoUrl = 'https://cdn.aitopia.ai/fox.png';

  it('--dry-run shows the numbered plan with kinds, why and credits, then the total; nothing runs', async () => {
    await editCommand(ctx(), photoUrl, ['remove the background, upscale, make it 9:16'], { dryRun: true });
    expect(calls.map((c) => c.name)).toEqual(['edit_media']);
    expect(calls[0]?.args).toEqual({ assetUrl: photoUrl, instruction: 'remove the background, upscale, make it 9:16', mediaType: 'image', dryRun: true });
    expect(stdout.text).toContain(`Plan: ${EDIT_SUMMARY}`);
    expect(stdout.text).toContain('  1. Bria Remove Background (model) · 2 credits');
    expect(stdout.text).toContain('     Cuts the subject out cleanly.');
    expect(stdout.text).toContain('  3. Resize (ffmpeg) · 0 credits');
    expect(stdout.text).toContain('Total: 6 credits');
    expect(stdout.text).toContain('Balance: 8,951 credits available');
    expect(stdout.text).toContain('Nothing was run or charged.');
  });

  it('--dry-run of a local file prints a --plan command; --plan runs it on the uploaded file without uploading again', async () => {
    const photo = join(dir, 'fox.png');
    writeFileSync(photo, 'png');
    await editCommand(ctx(), photo, ['remove the background'], { dryRun: true });
    expect(stdout.text).toContain('To run exactly this plan at this price (within 1 hour):');
    expect(stdout.text).toContain(`aitopia edit ${shellWord(photo)} ${shellWord('remove the background')} --plan=plan-token-abcdefghijkl`);
    const uploaded = calls.find((c) => c.name === 'edit_media')?.args.assetUrl;
    calls.length = 0;
    await editCommand(ctx(), photo, ['remove', 'the', 'background'], { plan: 'plan-token-abcdefghijkl', output: dir, force: true });
    expect(calls.map((c) => c.name)[0]).toBe('edit_media');
    expect(calls.some((c) => c.name === 'upload_asset')).toBe(false);
    expect(calls[0]?.args).toMatchObject({ assetUrl: uploaded, instruction: 'remove the background', planToken: 'plan-token-abcdefghijkl' });
  });

  it('--plan refuses another instruction, a changed file, and --dry-run; an unknown token is the server\'s PLAN_EXPIRED', async () => {
    const photo = join(dir, 'fox.png');
    writeFileSync(photo, 'png');
    await editCommand(ctx(), photo, ['remove the background'], { dryRun: true });
    calls.length = 0;
    await expect(editCommand(ctx(), photo, ['upscale'], { plan: 'plan-token-abcdefghijkl' })).rejects.toThrow(/another file or instruction/);
    await expect(editCommand(ctx(), photo, ['upscale'], { plan: 'plan-token-abcdefghijkl', dryRun: true })).rejects.toThrow(/leave out --dry-run/);
    writeFileSync(photo, 'png, edited since');
    await expect(editCommand(ctx(), photo, ['remove the background'], { plan: 'plan-token-abcdefghijkl' })).rejects.toThrow(/has changed since the --dry-run/);
    expect(calls).toHaveLength(0);
    const error = await editCommand(ctx(), photoUrl, ['upscale'], { plan: 'unknown-token-0000000' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PLAN_EXPIRED' });
  });

  it('--dry-run waits for the estimate when planning outlasts the inline wait', async () => {
    await editCommand(ctx(), photoUrl, ['slow plan: upscale'], { dryRun: true });
    expect(calls.map((c) => c.name)).toEqual(['edit_media', 'get_run_status', 'get_run_status']);
    expect(stdout.text).toContain(`Plan: ${EDIT_SUMMARY}`);
    expect(stdout.text).toContain('Total: 6 credits');
    expect(stdout.text).toContain('Nothing was run or charged.');
  });

  it('--dry-run with a short balance says not enough credits and still returns (exit 0)', async () => {
    balance = 3;
    await editCommand(ctx(), photoUrl, ['upscale'], { dryRun: true });
    expect(stdout.text).toContain('Not enough credits for this edit.');
    expect(stdout.text).toContain('Buy credits: https://aitopia.ai/pricing');
  });

  it('runs once, prints the plan and each step as it starts, polls with wait and saves <name>-edited', async () => {
    const out = join(dir, 'edits');
    await editCommand(ctx(), `${base}/files/fox.png`, ['remove the background'], { output: `${out}/` });
    expect(calls.map((c) => c.name)).toEqual(['edit_media', 'get_run_status', 'get_run_status']);
    expect(calls[0]?.progressToken).toBeDefined();
    expect(calls[1]?.args).toEqual({ runToken: 'edit-1', wait: 20 });
    expect(stdout.text).toContain(`Plan: ${EDIT_SUMMARY}`);
    expect(stderr.text).toContain('Step 1/3 · Removing the background with Bria Remove Background');
    expect(stderr.text).toContain('Step 2/3 · Upscaling with Topaz Image Upscale');
    expect(stderr.text).not.toContain('Topaz Image Upscale — 3 s');
    expect(readdirSync(out)).toEqual(['fox-edited.png']);
    expect(stdout.text).toContain('Saved');
    expect(stdout.text).toContain('Total: 6 credits');
    expect(stdout.text).toContain('Open in AITOPIA: https://aitopia.ai/c/e1');
  }, 15_000);

  it('--keep-steps also saves every intermediate file as <name>-step-N', async () => {
    const out = join(dir, 'steps');
    await editCommand(ctx(), photoUrl, ['inline: remove the background'], { output: `${out}/`, keepSteps: true });
    expect(readdirSync(out).sort()).toEqual(['fox-edited-step-1.png', 'fox-edited-step-2.png', 'fox-edited.png']);
  });

  it('--keep-steps with -o <file> names the steps after that file', async () => {
    const out = join(dir, 'named');
    await editCommand(ctx(), photoUrl, ['inline'], { output: join(out, 'story.png'), keepSteps: true });
    expect(readdirSync(out).sort()).toEqual(['story-step-1.png', 'story-step-2.png', 'story.png']);
  });

  it('a step failing mid-chain saves the finished step, exits 1 with the error and keeps the plan in the data', async () => {
    const out = join(dir, 'broken');
    const error = (await editCommand(ctx(), photoUrl, ['break it'], { output: `${out}/` }).catch((e: unknown) => e)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toBe('Step 2 (Topaz Image Upscale) failed: Topaz Image Upscale could not process this image.');
    expect(error.hint).toContain('do not run them again');
    expect(readdirSync(out)).toEqual(['fox-edited-step-1.png']);
    expect(stdout.text).toContain('(step 1)');
    expect(error.data.files).toEqual([join(out, 'fox-edited-step-1.png')]);
    expect(jsonStatus(error)).toBe('partial');
    expect(calls.filter((c) => c.name === 'edit_media')).toHaveLength(1);
    expect(error.notes).toContain('Open in AITOPIA: https://aitopia.ai/c/e2');
  }, 15_000);

  it('OVER_BUDGET: exit 1, shows the plan and the total, nothing ran', async () => {
    const error = (await editCommand(ctx(), photoUrl, ['upscale'], { maxCredits: 3 }).catch((e: unknown) => e)) as CliError;
    expect(calls[0]?.args.maxCredits).toBe(3);
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('OVER_BUDGET');
    expect(error.message).toBe('This edit needs 6 credits, more than your limit of 3 credits.');
    expect(error.hint).toContain('Nothing ran');
    expect(stdout.text).toContain('  2. Topaz Image Upscale (model) · 4 credits');
    expect(stdout.text).toContain('Total: 6 credits');
    expect(calls.map((c) => c.name)).toEqual(['edit_media']);
  });

  it('PLAN_UNAVAILABLE: exit 1, says nothing was spent', async () => {
    const error = (await editCommand(ctx(), photoUrl, ['planner down'], {}).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('PLAN_UNAVAILABLE');
    expect(error.hint).toContain('Nothing was spent');
  });

  it('a local file is uploaded first, then edited by its hosted URL', async () => {
    const photo = join(dir, 'My Photo.PNG');
    writeFileSync(photo, 'tiny png');
    const out = join(dir, 'local');
    await editCommand(ctx(), photo, ['inline', 'make', 'it', '9:16'], { output: `${out}/` });
    expect(calls.map((c) => c.name)).toEqual(['upload_asset', 'edit_media']);
    expect(calls[1]?.args).toEqual({ assetUrl: 'https://cdn.aitopia.ai/uploaded.png', instruction: 'inline make it 9:16', mediaType: 'image' });
    expect(readdirSync(out)).toEqual(['my-photo-edited.png']);
  });

  it('a missing local file is a usage error before connecting', async () => {
    const error = (await editCommand(ctx(), join(dir, 'nope.png'), ['upscale'], {}).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it('--json: stdout holds exactly one object with the plan, the files and per-step files', async () => {
    const out = join(dir, 'json');
    await editCommand(ctx(true), photoUrl, ['remove the background'], { output: `${out}/`, keepSteps: true });
    const parsed = JSON.parse(stdout.text) as { status: string; files: string[]; plan: { steps: Array<{ file?: string }> }; totalCredits: number };
    expect(parsed.status).toBe('completed');
    expect(parsed.totalCredits).toBe(6);
    expect(parsed.files.map((f) => f.slice(out.length + 1))).toEqual(['fox-edited.png', 'fox-edited-step-1.png', 'fox-edited-step-2.png']);
    expect(parsed.plan.steps[0]?.file).toBe(join(out, 'fox-edited-step-1.png'));
    expect(stdout.text).not.toContain('Plan:');
    expect(stderr.text).not.toContain('Step 1/3');
  }, 15_000);

  it('--json --dry-run prints the estimate object only', async () => {
    await editCommand(ctx(true), photoUrl, ['upscale'], { dryRun: true });
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'estimate', totalCredits: 6, affordable: true });
  });

  it('--json mid-chain failure: status partial with the finished step file (via jsonStatus)', async () => {
    const out = join(dir, 'jb');
    const error = (await editCommand(ctx(true), photoUrl, ['break'], { output: `${out}/` }).catch((e: unknown) => e)) as CliError;
    expect(stdout.text).toBe('');
    expect(jsonStatus(error)).toBe('partial');
    const plan = error.data.plan as { steps: Array<{ status: string; file?: string; error?: string }> };
    expect(plan.steps[0]?.file).toBe(join(out, 'fox-edited-step-1.png'));
    expect(plan.steps[1]).toMatchObject({ index: 2, status: 'failed' });
    expect(plan.steps[2]).toMatchObject({ status: 'skipped' });
  }, 15_000);

  it('Ctrl+C after a failed chain lists the finished step as ready', async () => {
    brokenFiles = true;
    await editCommand(ctx(), photoUrl, ['break'], { output: join(dir, 'x') }).catch(() => undefined);
    const context = ctx();
    reportInterrupt(context.out);
    expect(stderr.text).toContain(`step 1: ${base}/files/edit-step-1.png`);
  }, 15_000);
});

describe('edit, real server shapes', () => {
  const photoUrl = 'https://cdn.aitopia.ai/fox.png';

  it('--dry-run shows each step basis, and says when the plan is over --max-credits', async () => {
    await editCommand(ctx(), photoUrl, ['upscale'], { dryRun: true, maxCredits: 5 });
    expect(calls[0]?.args).toMatchObject({ dryRun: true, maxCredits: 5 });
    expect(stdout.text).toContain('     Basis: 1 image at 4K x 4 credits.');
    expect(stdout.text).toContain('Over your --max-credits limit of 5 credits: it would not run.');
  });

  it('mid-chain partial with --keep-steps saves every finished item; step numbers come from index', async () => {
    const out = join(dir, 'pk');
    const error = (await editCommand(ctx(), photoUrl, ['break'], { output: `${out}/`, keepSteps: true }).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(1);
    expect(readdirSync(out)).toEqual(['fox-edited-step-1.png']);
    expect(stdout.text).toContain('  3. Resize (ffmpeg) · 0 credits · skipped');
  }, 15_000);

  it('a partial for lack of credits exits 4 with the buy link, and still saves the finished step', async () => {
    const out = join(dir, 'pc');
    const error = (await editCommand(ctx(), photoUrl, ['break credits'], { output: `${out}/` }).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(4);
    expect(error.code).toBe('INSUFFICIENT_CREDITS');
    expect(error.notes).toContain('Buy credits: https://aitopia.ai/pricing');
    expect(readdirSync(out)).toEqual(['fox-edited-step-1.png']);
  }, 15_000);

  it('PLAN_INVALID, NOT_SUPPORTED and SERVER_RESTARTING get CLI hints (nothing ran)', () => {
    for (const code of ['PLAN_INVALID', 'NOT_SUPPORTED', 'SERVER_RESTARTING']) {
      const error = failureToError({ status: 'failed', code, error: 'x', retryable: code !== 'NOT_SUPPORTED' });
      expect(error.exitCode).toBe(1);
      expect(error.hint).toContain('Nothing ran');
    }
  });
});

describe('edit, server update (POLL_FAILED, PRICE_UNKNOWN, estimated and unchanged steps)', () => {
  const photoUrl = 'https://cdn.aitopia.ai/fox.png';

  it('POLL_FAILED from get_run_status is outcome unknown: exit 5, check AITOPIA before running again', async () => {
    const error = (await editCommand(ctx(), photoUrl, ['poll fails'], {}).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(5);
    expect(error.code).toBe('POLL_FAILED');
    expect(error.hint).toContain('Check Open in AITOPIA before running it again');
    expect(error.notes).toContain('Check it with: aitopia status edit-poll --wait');
    expect(jsonStatus(error)).toBe('unknown');
  }, 15_000);

  it('a partial with POLL_FAILED still saves the finished step, then exits 5', async () => {
    const out = join(dir, 'pp');
    const error = (await editCommand(ctx(), photoUrl, ['poll partial'], { output: `${out}/` }).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(5);
    expect(error.message).toContain('Step 2 (Topaz Image Upscale) could not be checked');
    expect(readdirSync(out)).toEqual(['fox-edited-step-1.png']);
  });

  it('PRICE_UNKNOWN without --max-credits: exit 1, the plan is shown, nothing ran', async () => {
    const error = (await editCommand(ctx(), photoUrl, ['unknown price'], {}).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(1);
    expect(error.code).toBe('PRICE_UNKNOWN');
    expect(error.hint).toContain('Nothing ran or was charged');
    expect(stdout.text).toContain('  2. Topaz Image Upscale (model)\n');
    expect(stdout.text.match(/Plan:/g)).toHaveLength(1);
    expect(calls.map((c) => c.name)).toEqual(['edit_media']);
  });

  it('PLAN_UNAVAILABLE when the rate store is down: nothing spent, try again later', async () => {
    const error = (await editCommand(ctx(), photoUrl, ['rate store down'], {}).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(1);
    expect(error.hint).toBe('AITOPIA could not plan this edit right now. Nothing was spent; try again later.');
  });

  it('--dry-run marks a listed price as approximate', async () => {
    await editCommand(ctx(), photoUrl, ['estimated'], { dryRun: true });
    expect(stdout.text).toContain('  2. Topaz Image Upscale (model) · ~4 credits (listed price)');
  });

  it('an unchanged step and noTransformNeeded say so, and the file is still saved', async () => {
    const out = join(dir, 'same');
    await editCommand(ctx(), photoUrl, ['already 9:16'], { output: `${out}/` });
    expect(stdout.text).toContain('  1. Resize (ffmpeg) · no change needed, 0 credits');
    expect(stdout.text).toContain('The file was already in the requested form; nothing needed changing.');
    expect(readdirSync(out)).toEqual(['fox-edited.png']);
  });
});

const names = () => calls.map((c) => c.name);
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as CliError);

describe('projects', () => {
  it('matchNamed: exact id, exact name, any-case name, ambiguous names, nothing', () => {
    const list = [
      { id: 'p-1', name: 'Spring' },
      { id: 'p-2', name: 'Dup' },
      { id: 'p-3', name: 'dup' },
    ];
    expect(matchNamed(list, 'p-2', 'project')?.id).toBe('p-2');
    expect(matchNamed(list, 'Dup', 'project')?.id).toBe('p-2');
    expect(matchNamed(list, ' spring ', 'project')?.id).toBe('p-1');
    expect(matchNamed(list, 'nothing', 'project')).toBeUndefined();
    let error: CliError | undefined;
    try {
      matchNamed(list, 'DUP', 'project');
    } catch (e) {
      error = e as CliError;
    }
    expect(error?.exitCode).toBe(2);
    expect(error?.code).toBe('AMBIGUOUS_NAME');
    expect(error?.hint).toContain('p-2 (Dup), p-3 (dup)');
  });

  it('show finds a project by name on a later page and a folder by name, then lists its files', async () => {
    await projectsShowCommand(ctx(), 'spring CAMPAIGN', { folder: 'banners' });
    expect(names()).toEqual(['list_projects', 'list_projects', 'list_project_assets', 'list_project_assets']);
    expect(calls[1]?.args).toEqual({ limit: 100, offset: 3 });
    expect(calls[3]?.args).toEqual({ projectId: 'p-4444', folderId: 'f-1' });
    expect(stdout.text).toContain('Spring campaign / Banners  1 file');
    expect(stdout.text).toContain('Fox banner');
    expect(stdout.text).not.toContain('Teaser');
  });

  it('show lists folders with their paths and every file', async () => {
    await projectsShowCommand(ctx(), 'p-4444', {});
    expect(stdout.text).toContain('Banners / Close-ups');
    expect(stdout.text).toMatch(/Teaser\s+video\s+-\s+2026-10-02/);
  });

  it('an ambiguous or missing project is a clear error before anything else', async () => {
    const ambiguous = await failure(projectsShowCommand(ctx(), 'DUP', {}));
    expect(ambiguous?.code).toBe('AMBIGUOUS_NAME');
    expect(ambiguous?.exitCode).toBe(2);
    const missing = await failure(projectsShowCommand(ctx(), 'Nope', {}));
    expect(missing?.code).toBe('PROJECT_NOT_FOUND');
    expect(missing?.exitCode).toBe(1);
    expect(missing?.hint).toContain('aitopia projects');
    expect(names()).not.toContain('list_project_assets');
  });

  it('list prints name, files, id and link; create prints the new project', async () => {
    await projectsListCommand(ctx(), {});
    expect(stdout.text).toMatch(/NAME\s+FILES\s+ID\s+LINK/);
    expect(stdout.text).toContain('Podcast');
    expect(stderr.text).toContain('Next page: --offset 3');
    await projectsCreateCommand(ctx(), 'New one', { description: 'x' });
    expect(calls.at(-1)?.args).toEqual({ name: 'New one', description: 'x' });
    expect(stdout.text).toContain('Created project "New one" (p-new)');
  });

  it('image --project/--folder resolves both once, before the paid call, and sends projectId/folderId', async () => {
    await imageCommand(ctx(), ['fox'], { project: 'spring campaign', folder: 'close-ups', output: `${join(dir, 'o')}/` });
    expect(names()).toEqual(['list_projects', 'list_projects', 'list_project_assets', 'list_models', 'generate_image']);
    expect(calls.at(-1)?.args).toMatchObject({ prompt: 'fox', projectId: 'p-4444', folderId: 'f-2' });
    expect(stderr.text).toContain('Saving to project "Spring campaign", folder "Close-ups".');
  });

  it('image with a project that does not exist spends nothing', async () => {
    const error = await failure(imageCommand(ctx(), ['fox'], { project: 'Nope' }));
    expect(error?.code).toBe('PROJECT_NOT_FOUND');
    expect(names()).toEqual(['list_projects', 'list_projects']);
  });

  it('a missing folder also stops before the paid call; --folder without --project is a usage error', async () => {
    const error = await failure(imageCommand(ctx(), ['fox'], { project: 'Spring campaign', folder: 'Nope' }));
    expect(error?.code).toBe('FOLDER_NOT_FOUND');
    expect(names()).not.toContain('generate_image');
    calls = [];
    const usage = await failure(imageCommand(ctx(), ['fox'], { folder: 'Banners' }));
    expect(usage?.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it('batch, edit and video pass the resolved project too', async () => {
    const file = join(dir, 'b.json');
    writeFileSync(file, JSON.stringify([{ kind: 'image', prompt: 'fox', modelId: 'google/nano-banana-2' }]));
    await batchCommand(ctx(), file, { project: 'Podcast', dryRun: true });
    expect(calls.find((c) => c.name === 'generate_batch')?.args).toMatchObject({ projectId: 'p-1111' });
    calls = [];
    await editCommand(ctx(), 'https://cdn.aitopia.ai/fox.png', ['remove', 'the', 'background'], { project: 'Podcast', dryRun: true });
    expect(calls.find((c) => c.name === 'edit_media')?.args).toMatchObject({ projectId: 'p-1111' });
    calls = [];
    await videoCommand(ctx(), ['waves'], { model: 'acme/i2v', project: 'Podcast', dryRun: true });
    expect(calls.find((c) => c.name === 'generate_video')?.args).toMatchObject({ projectId: 'p-1111' });
  });

  it('move: URLs and ids into a project folder; files not found are listed and exit 1', async () => {
    await projectsMoveCommand(ctx(), ['https://cdn.aitopia.ai/a.png', 'asset-1234abcd'], { to: 'Spring campaign', folder: 'Banners' });
    expect(calls.at(-1)?.args).toEqual({ projectId: 'p-4444', folderId: 'f-1', assetUrls: ['https://cdn.aitopia.ai/a.png'], assetIds: ['asset-1234abcd'] });
    expect(stdout.text).toContain('Moved 2 files to "Spring campaign" / "Banners".');
    const error = await failure(projectsMoveCommand(ctx(true), ['https://cdn.aitopia.ai/a.png', 'https://cdn.aitopia.ai/missing.png'], { to: 'Podcast' }));
    expect(error?.code).toBe('ASSETS_NOT_FOUND');
    expect(error?.exitCode).toBe(1);
    expect(error?.data).toMatchObject({ status: 'partial', moved: 1, notFound: ['https://cdn.aitopia.ai/missing.png'] });
    expect(jsonStatus(error as CliError)).toBe('partial');
  });

  it('move --out sends projectId null; --to with --out, or neither, is a usage error', async () => {
    await projectsMoveCommand(ctx(), ['https://cdn.aitopia.ai/a.png'], { out: true });
    expect(calls.at(-1)?.args).toEqual({ projectId: null, assetUrls: ['https://cdn.aitopia.ai/a.png'] });
    expect(stdout.text).toContain('out of their project');
    calls = [];
    expect((await failure(projectsMoveCommand(ctx(), ['x-12345678'], { out: true, to: 'Podcast' })))?.exitCode).toBe(2);
    expect((await failure(projectsMoveCommand(ctx(), ['x-12345678'], {})))?.exitCode).toBe(2);
    expect((await failure(projectsMoveCommand(ctx(), ['./local.png'], { out: true })))?.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it('delete asks first: "no" deletes nothing, "yes" deletes and says the files stay in Creations', async () => {
    const asked: string[] = [];
    const c = ctx();
    c.confirm = async (q) => {
      asked.push(q);
      return false;
    };
    const declined = await failure(projectsDeleteCommand(c, 'spring campaign', {}));
    expect(declined?.exitCode).toBe(1);
    expect(declined?.code).toBe('NOT_CONFIRMED');
    expect(declined?.message).toBe('Not deleted.');
    expect(asked[0]).toContain('Delete the project "Spring campaign" and its folders? Its 3 files stay in your AITOPIA Creations.');
    expect(names()).not.toContain('delete_project');

    const c2 = ctx();
    c2.confirm = async () => true;
    await projectsDeleteCommand(c2, 'spring campaign', {});
    expect(calls.at(-1)).toMatchObject({ name: 'delete_project', args: { projectId: 'p-4444' } });
    expect(stdout.text).toContain('Its 3 files stay in your AITOPIA Creations, outside any project.');
  });

  it('delete without a terminal (or with --json) needs --yes; --yes deletes without asking', async () => {
    const error = await failure(projectsDeleteCommand(ctx(true), 'Podcast', {}));
    expect(error?.exitCode).toBe(2);
    expect(error?.message).toContain('Add --yes');
    expect(names()).not.toContain('delete_project');
    await projectsDeleteCommand(ctx(true), 'Podcast', { yes: true });
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'completed', deleted: { id: 'p-1111' } });
  });
});

describe('voices', () => {
  it('create refuses without --consent (exit 2, explains it) before connecting', async () => {
    const sample = join(dir, 'me.m4a');
    writeFileSync(sample, 'audio bytes');
    const error = await failure(voicesCreateCommand(ctx(), 'My voice', sample, {}));
    expect(error?.exitCode).toBe(2);
    expect(error?.message).toContain('your own voice, or that the speaker gave you permission');
    expect(calls).toEqual([]);
  });

  it('create uploads a local sample, follows a running clone to the end and saves the preview', async () => {
    const sample = join(dir, 'me.m4a');
    writeFileSync(sample, 'audio bytes');
    const out = join(dir, 'previews');
    await voicesCreateCommand(ctx(), 'Slow voice', sample, { consent: true, language: 'English', output: `${out}/` });
    expect(names()).toEqual(['upload_asset', 'create_voice', 'create_voice']);
    expect(calls[1]?.args).toEqual({ consent: true, name: 'Slow voice', sampleUrl: 'https://cdn.aitopia.ai/uploaded.png', language: 'English' });
    // Finished by its voiceId, never a new clone.
    expect(calls[2]?.args).toEqual({ voiceId: 'v-slow', consent: true });
    expect(stderr.text).toContain('(150 credits)');
    expect(stdout.text).toContain('Ready: the voice "Slow voice" (v-slow)');
    expect(stdout.text).toContain(`Preview: ${base}/files/voice-preview.mp3`);
    expect(readdirSync(out)).toEqual(['slow-voice-preview.mp3']);
    expect(stdout.text).toContain('aitopia audio "Hello there." --voice "Slow voice"');
  }, 15_000);

  it('create --dry-run shows the 150-credit price; --no-download prints the preview URL', async () => {
    const sample = join(dir, 'me.m4a');
    writeFileSync(sample, 'audio bytes');
    await voicesCreateCommand(ctx(), 'Mine', sample, { consent: true, dryRun: true });
    expect(calls.at(-1)?.args).toMatchObject({ consent: true, dryRun: true });
    expect(stdout.text).toContain('Estimate: 150 credits');
    calls = [];
    await voicesCreateCommand(ctx(), 'Mine', 'https://cdn.aitopia.ai/take.mp3', { consent: true, download: false });
    // An AITOPIA URL is used as is.
    expect(names()).toEqual(['create_voice']);
    expect(stdout.text).toContain(`${base}/files/voice-preview.mp3`);
  });

  it('create without a sample re-creates one of your voices by its voiceId', async () => {
    await voicesCreateCommand(ctx(), 'my voice', undefined, { consent: true, download: false });
    expect(calls.at(-1)?.args).toEqual({ consent: true, voiceId: 'v-1' });
    expect(stdout.text).toContain('was re-created');
  });

  it('VOICE_NAME_TAKEN and SAMPLE_NOT_OWNED get CLI hints', async () => {
    const taken = await failure(voicesCreateCommand(ctx(), 'Taken', 'https://cdn.aitopia.ai/take.mp3', { consent: true }));
    expect(taken?.code).toBe('VOICE_NAME_TAKEN');
    expect(taken?.hint).toContain('aitopia voices delete');
    const foreign = failureToError({ code: 'SAMPLE_NOT_OWNED', error: 'The recording must be a file the user uploaded.' });
    expect(foreign.hint).toContain('aitopia upload');
  });

  it('list shows state, dates and the "may have expired" note', async () => {
    await voicesListCommand(ctx());
    expect(stdout.text).toMatch(/My voice\s+ready\s+2026-09-01\s+never\s+v-1\s+may have expired/);
    expect(stdout.text).toContain('still being created');
    expect(stderr.text).toContain('aitopia voices create <name> --consent (150 credits)');
  });

  it('delete: a voice still being created needs --force (hint says so); --yes and --force pass through', async () => {
    const error = await failure(voicesDeleteCommand(ctx(), 'cloning one', { yes: true }));
    expect(error?.code).toBe('VOICE_STILL_CLONING');
    expect(error?.hint).toContain('--force');
    await voicesDeleteCommand(ctx(), 'cloning one', { yes: true, force: true });
    expect(calls.at(-1)?.args).toEqual({ voiceId: 'v-2', force: true });
    expect(stdout.text).toContain('Deleted the voice "Cloning one".');
    const json = await failure(voicesDeleteCommand(ctx(true), 'My voice', {}));
    expect(json?.exitCode).toBe(2);
  });

  it('audio --voice resolves the name to voiceId and lets the voice pick its model', async () => {
    const out = join(dir, 'speech');
    await audioCommand(ctx(), ['Thanks', 'for', 'watching.'], { voice: 'MY VOICE', output: `${out}/` });
    expect(names()).toEqual(['list_voices', 'generate_audio']);
    expect(calls[1]?.args).toEqual({ prompt: 'Thanks for watching.', voiceId: 'v-1' });
    expect(stderr.text).toContain('Voice: My voice');
    expect(readdirSync(out)).toHaveLength(1);
  });

  it('audio --voice: VOICE_EXPIRED says how to re-create it and what it costs; an unknown voice spends nothing', async () => {
    const error = await failure(audioCommand(ctx(), ['this', 'voice', 'expired'], { voice: 'My voice' }));
    expect(error?.code).toBe('VOICE_EXPIRED');
    expect(error?.hint).toContain('aitopia voices create <name> --consent');
    expect(error?.hint).toContain('150 credits');
    calls = [];
    const missing = await failure(audioCommand(ctx(), ['hi'], { voice: 'Nobody' }));
    expect(missing?.code).toBe('VOICE_NOT_FOUND');
    expect(names()).toEqual(['list_voices']);
    expect((await failure(audioCommand(ctx(), ['hi'], { voice: 'My voice', model: 'x/y' })))?.exitCode).toBe(2);
  });
});

describe('audio --emotion', () => {
  it('sends emotion as a top-level generate_audio argument, with --voice and --project', async () => {
    const out = join(dir, 'happy');
    await audioCommand(ctx(), ['We', 'did', 'it!'], { voice: 'My voice', emotion: 'happy', project: 'spring campaign', output: `${out}/` });
    expect(names()).toEqual(['list_voices', 'list_projects', 'list_projects', 'generate_audio']);
    expect(calls.at(-1)?.args).toEqual({ prompt: 'We did it!', voiceId: 'v-1', emotion: 'happy', projectId: 'p-4444' });
    expect(stderr.text).not.toContain('Notice:');
    expect(readdirSync(out)).toHaveLength(1);
  });

  it('without --voice: emotion goes with the chosen model, and the server note that it is not supported is printed', async () => {
    await audioCommand(ctx(), ['Hello'], { model: 'x/tts', emotion: 'calm', output: `${join(dir, 'calm')}/` });
    expect(calls.at(-1)?.args).toEqual({ prompt: 'Hello', selectedModelId: 'x/tts', allowAnyModel: true, emotion: 'calm' });
    expect(stderr.text).toContain('Notice: emotion is not supported by this model and was ignored.');
  });

  it('--dry-run and --json carry emotion; only the emotion note is repeated as a notice', async () => {
    await audioCommand(ctx(), ['Hello'], { model: 'x/tts', emotion: 'sad', dryRun: true });
    expect(calls.at(-1)?.args).toEqual({ prompt: 'Hello', selectedModelId: 'x/tts', allowAnyModel: true, emotion: 'sad', dryRun: true });
    expect(stdout.text).toContain('Estimate: 15 credits');
    expect(stderr.text).toContain('Notice: emotion is not supported by this model and was ignored.');
    expect(stderr.text).not.toContain('Estimate only');
    await audioCommand(ctx(true), ['Hello'], { voice: 'My voice', emotion: 'fluent', dryRun: true });
    expect(calls.at(-1)?.args).toEqual({ prompt: 'Hello', voiceId: 'v-1', emotion: 'fluent', dryRun: true });
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'estimate', credits: 15 });
    expect(stderr.text).not.toContain('Notice:');
  });

  it('an emotion outside the list is a usage error (exit 2) and nothing is called', async () => {
    const error = await failure(audioCommand(ctx(), ['Hello'], { emotion: 'joyful' }));
    expect(error?.exitCode).toBe(2);
    expect(error?.message).toContain('happy, sad, angry, fearful, disgusted, surprised, calm, fluent');
    const program = buildProgram();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    for (const sub of program.commands) sub.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    const parsed = await program.parseAsync(['node', 'aitopia', 'audio', 'Hello', '--emotion', 'joyful', '--server', `${base}/mcp`]).catch((e: unknown) => e);
    expect((parsed as { code?: string }).code).toBe('commander.invalidArgument');
    expect(calls).toEqual([]);
  });
});

describe('transcribe', () => {
  it('a video: uploads it, extracts the audio with audio_tools, transcribes with Grok and saves <name>.srt', async () => {
    const video = join(dir, 'talk.mp4');
    writeFileSync(video, 'video bytes');
    const out = join(dir, 'subs');
    await transcribeCommand(ctx(), video, { output: `${out}/` });
    // The price check before the paid run is free (dryRun).
    expect(names()).toEqual(['upload_asset', 'audio_tools', 'run_model', 'run_model']);
    expect(calls[1]?.args).toEqual({ input: { assetUrl: 'https://cdn.aitopia.ai/uploaded.png', operation: 'extract' } });
    expect(calls[2]?.args.dryRun).toBe(true);
    expect(calls[3]?.args).toEqual({ modelId: 'xai/grok-speech-to-text', input: { audio: 'https://cdn.aitopia.ai/extracted.mp3', timestamps: true } });
    expect(readdirSync(out)).toEqual(['talk.srt']);
    const srt = readFileSync(join(out, 'talk.srt'), 'utf8');
    expect(srt).toBe(
      '1\n00:00:00,100 --> 00:00:00,800\nHello there.\n\n2\n00:00:01,000 --> 00:00:01,800\nThis is a test\n\n3\n00:00:02,600 --> 00:00:03,500\nafter a pause\n',
    );
    expect(stdout.text).toContain('Saved');
    expect(stdout.text).toContain('(3 cues, en, 0:04)');
    expect(stderr.text).toContain('Extracting the audio (1 credit)');
    // The price comes from the dryRun estimate, never hard-coded.
    expect(stderr.text).toContain('Transcribing with xai/grok-speech-to-text (50 credits)');
  });

  it('a language outside Grok\'s 25 runs Whisper with an SRT and keeps its segments', async () => {
    const out = join(dir, 'sw.srt');
    await transcribeCommand(ctx(), 'https://example.com/podcast.mp3', { language: 'sw', output: out });
    expect(names()).toEqual(['run_model', 'run_model']);
    expect(calls[1]?.args).toEqual({ modelId: 'openai/whisper', input: { audio: 'https://example.com/podcast.mp3', transcription: 'srt', language: 'sw' } });
    expect(readFileSync(out, 'utf8')).toBe('1\n00:00:00,000 --> 00:00:02,000\nHabari ya asubuhi.\n\n2\n00:00:02,000 --> 00:00:05,000\nKaribu sana.\n');
  });

  it('--format txt prints the text; json saves the words; the -o extension picks the format; --words gives one cue per word', async () => {
    await transcribeCommand(ctx(), 'https://example.com/a.mp3', { format: 'txt' });
    expect(stdout.text.trim()).toBe('Hello there. This is a test after a pause');
    const json = join(dir, 'a.json');
    await transcribeCommand(ctx(), 'https://example.com/a.mp3', { output: json });
    const saved = JSON.parse(readFileSync(json, 'utf8')) as { words: unknown[]; language: string; modelId: string };
    expect(saved.words).toHaveLength(9);
    expect(saved).toMatchObject({ language: 'en', modelId: 'xai/grok-speech-to-text' });
    const words = join(dir, 'w.srt');
    await transcribeCommand(ctx(), 'https://example.com/a.mp3', { output: words, words: true });
    expect(readFileSync(words, 'utf8').split('\n\n')).toHaveLength(9);
  });

  it('--json prints one object with the text, cues and saved file', async () => {
    const out = join(dir, 'j.srt');
    await transcribeCommand(ctx(true), 'https://example.com/a.mp3', { output: out });
    const parsed = JSON.parse(stdout.text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ status: 'completed', modelId: 'xai/grok-speech-to-text', format: 'srt', cueCount: 3, files: [out] });
  });

  it('--dry-run of a local video prices both steps and uploads nothing', async () => {
    const video = join(dir, 'talk.mp4');
    writeFileSync(video, 'video bytes');
    await transcribeCommand(ctx(), video, { dryRun: true });
    expect(names()).toEqual(['run_model', 'audio_tools']);
    expect(calls.every((c) => c.args.dryRun === true)).toBe(true);
    expect(stdout.text).toContain('Estimate: 51 credits (1 credit to extract the audio, 50 credits to transcribe it)');
    expect(stdout.text).toContain('Nothing was submitted or charged.');
  });

  it('an image or a bad --format is a usage error before connecting', async () => {
    const image = join(dir, 'x.png');
    writeFileSync(image, 'png');
    expect((await failure(transcribeCommand(ctx(), image, {})))?.exitCode).toBe(2);
    expect((await failure(transcribeCommand(ctx(), 'https://example.com/a.mp3', { format: 'vtt' })))?.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('subtitle cues', () => {
  const w = (text: string, start: number, end: number) => ({ text, start, end });

  it('break after sentence punctuation and on pauses over 0.6 s', () => {
    const cues = cuesFromWords([w('Hi.', 0, 0.3), w('Next', 0.4, 0.6), w('one', 0.7, 0.9), w('later', 1.6, 1.9)]);
    expect(cues.map((c) => c.text)).toEqual(['Hi.', 'Next one', 'later']);
  });

  it('a cue lasts at most 3.5 s and holds at most two lines of 42 characters', () => {
    const slow = Array.from({ length: 10 }, (_, i) => w(`w${i}`, i * 0.5, i * 0.5 + 0.45));
    for (const cue of cuesFromWords(slow)) expect(cue.end - cue.start).toBeLessThanOrEqual(3.5);
    const long = Array.from({ length: 30 }, (_, i) => w('wordy', i * 0.1, i * 0.1 + 0.05));
    for (const cue of cuesFromWords(long)) expect(cue.text.length).toBeLessThanOrEqual(84);
    const wrapped = wrapCue('one two three four five six seven eight nine ten eleven');
    expect(wrapped.split('\n')).toHaveLength(2);
    for (const line of wrapped.split('\n')) expect(line.length).toBeLessThanOrEqual(42);
  });

  it('SRT timestamps; a zero-length cue is held half a second; Whisper only outside Grok\'s languages', () => {
    expect(buildSrt([w('Hi', 3661.5, 3661.5)])).toBe('1\n01:01:01,500 --> 01:01:02,000\nHi\n');
    expect(sttModelFor(undefined)).toBe('xai/grok-speech-to-text');
    expect(sttModelFor('TR')).toBe('xai/grok-speech-to-text');
    expect(sttModelFor('sw')).toBe('openai/whisper');
  });
});

describe('new error code hints', () => {
  it.each([
    ['VOICE_EXPIRED', 'aitopia voices create <name> --consent'],
    ['VOICE_BEING_CREATED', 'not charged again'],
    ['VOICE_NAME_TAKEN', 'aitopia voices delete'],
    ['SAMPLE_NOT_OWNED', 'aitopia upload'],
    ['USE_CREATE_VOICE', 'aitopia voices create <name> <sample> --consent'],
    ['VOICES_UNAVAILABLE', 'try again later'],
    ['PROJECT_NOT_FOUND', 'aitopia projects'],
    ['FOLDER_NOT_FOUND', 'aitopia projects show'],
    ['PROJECTS_UNAVAILABLE', 'Creations'],
    ['NAME_CONFLICT', 'another name'],
    ['MODEL_DISABLED', 'aitopia models'],
    ['AGENT_NOT_FOUND', 'aitopia agents --q'],
    ['UPSTREAM_RUN_FAILED', 'try again later'],
    ['QUEUE_LIMIT_EXCEEDED', 'aitopia status'],
    ['INPUT_TOO_LARGE', 'uploaded first'],
  ])('%s', (code, wording) => {
    const error = failureToError({ code, error: 'Server text.', hint: 'Call create_voice with {voiceId}.' });
    expect(error.code).toBe(code);
    expect(error.exitCode).toBe(1);
    expect(error.hint).toContain(wording);
  });
});

describe('analyze', () => {
  it('uploads a local file, runs analyze_media and prints a readable report', async () => {
    const video = join(dir, 'clip.mp4');
    writeFileSync(video, 'video bytes');
    await analyzeCommand(ctx(), video, ['Is', 'the', 'logo', 'visible?'], { mode: 'scenes', language: 'tr' });
    expect(names()).toEqual(['upload_asset', 'analyze_media']);
    expect(calls[1]?.args).toEqual({ assetUrl: 'https://cdn.aitopia.ai/uploaded.png', mode: 'scenes', question: 'Is the logo visible?', language: 'tr' });
    expect(stdout.text).toContain('Answer:\n  Yes, at 0:01.');
    expect(stdout.text).toContain('Scenes (2):');
    expect(stdout.text).toContain('0:03-1:05  Cat jumps');
    expect(stdout.text).toContain('Text on screen:\n  - SALE');
  });

  it('maps ad-review, saves Markdown or JSON by the -o extension, and prices a dry run', async () => {
    const md = join(dir, 'report.md');
    await analyzeCommand(ctx(), 'https://example.com/ad.mp4', [], { mode: 'ad-review', output: md });
    expect(calls.at(-1)?.args).toEqual({ assetUrl: 'https://example.com/ad.mp4', mode: 'ad_review' });
    expect(readFileSync(md, 'utf8')).toMatch(/^## Summary\nA cat jumps on a sofa\./);
    expect(stdout.text).toContain('Saved');
    const json = join(dir, 'report.json');
    await analyzeCommand(ctx(), 'https://example.com/ad.mp4', [], { output: json });
    expect(JSON.parse(readFileSync(json, 'utf8')).scenes).toHaveLength(2);
    expect((await failure(analyzeCommand(ctx(), 'https://example.com/ad.mp4', [], { output: json })))?.exitCode).toBe(2);
    calls = [];
    await analyzeCommand(ctx(), 'https://example.com/ad.mp4', [], { dryRun: true });
    expect(calls[0]?.args.dryRun).toBe(true);
    expect(stdout.text).toContain('3 credits');
  });

  it('refuses a bad mode before connecting and reports a failed run', async () => {
    expect((await failure(analyzeCommand(ctx(), 'https://example.com/a.mp4', [], { mode: 'dance' })))?.exitCode).toBe(2);
    expect(calls).toEqual([]);
    const big = join(dir, 'big.mp4');
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1));
    const tooBig = await failure(analyzeCommand(ctx(), big, [], {}));
    expect(tooBig?.exitCode).toBe(2);
    expect(tooBig?.message).toMatch(/at most 2 MB for now; .*big\.mp4 is 2\.0 MB/);
    expect(calls).toEqual([]);
    const error = await failure(analyzeCommand(ctx(), 'https://example.com/unreachable.mp4', [], {}));
    expect(error?.exitCode).toBe(1);
  });

  it('renders the extras (answer, review, prompt) and falls back to the raw text', () => {
    const text = renderAnalysis({ adReview: { score: 7, hook: 'Fast cut', improvements: ['Add a CTA'] }, recreatePrompt: 'A cat, cinematic' }, false);
    expect(text).toContain('Ad review (7/10):\n  - Hook: Fast cut\n  - Improve: Add a CTA');
    expect(text).toContain('Prompt to re-create it:\n  A cat, cinematic');
    expect(renderAnalysis({ rawText: 'just words' }, true)).toBe('just words\n');
    expect(renderAnalysis({ summary: 's', note: 'fallback model used' }, false)).toContain('Note:\n  fallback model used');
  });
});

describe('review fixes: voices, transcribe, cues', () => {
  it('voices create without a sample: a ready voice asks first; no -> exit 1, nothing charged; --json needs --yes', async () => {
    const asked: string[] = [];
    const c = ctx();
    c.confirm = async (q) => {
      asked.push(q);
      return false;
    };
    const declined = await failure(voicesCreateCommand(c, 'fresh', undefined, { consent: true }));
    expect(declined?.code).toBe('NOT_CONFIRMED');
    expect(declined?.exitCode).toBe(1);
    expect(asked[0]).toContain('for 150 credits?');
    expect(names()).not.toContain('create_voice');
    const json = await failure(voicesCreateCommand(ctx(true), 'fresh', undefined, { consent: true }));
    expect(json?.exitCode).toBe(2);
    expect(json?.message).toContain('--yes');
    expect(names()).not.toContain('create_voice');
  });

  it('voices create without a sample: --yes re-creates a ready voice and shows the 150-credit price', async () => {
    await voicesCreateCommand(ctx(), 'Fresh', undefined, { consent: true, yes: true, download: false });
    expect(calls.at(-1)?.args).toEqual({ consent: true, voiceId: 'v-3' });
    expect(stderr.text).toContain('Re-creating the voice "Fresh" from its stored sample (150 credits)');
  });

  it('voices create without a sample: an expired voice needs no question but still shows the price; a cloning one is finished free', async () => {
    const c = ctx();
    c.confirm = async () => {
      throw new Error('must not ask');
    };
    await voicesCreateCommand(c, 'My voice', undefined, { consent: true, download: false });
    expect(stderr.text).toContain('(150 credits)');
    const c2 = ctx();
    c2.confirm = c.confirm;
    await voicesCreateCommand(c2, 'Cloning one', undefined, { consent: true, download: false }).catch(() => undefined);
    expect(calls.at(-1)?.args).toEqual({ consent: true, voiceId: 'v-2' });
    expect(stderr.text).toContain('not charged again');
    expect(stderr.text).not.toContain('150 credits');
  });

  it('voices delete answered no exits 1 "Not deleted"', async () => {
    const c = ctx();
    c.confirm = async () => false;
    const error = await failure(voicesDeleteCommand(c, 'Fresh', {}));
    expect(error?.message).toBe('Not deleted.');
    expect(error?.exitCode).toBe(1);
    expect(names()).not.toContain('delete_voice');
  });

  it('transcribe checks the output folder before anything is spent', async () => {
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const error = await failure(transcribeCommand(ctx(), 'https://example.com/a.mp3', { output: join(file, 'sub', 'out.srt') }));
    expect(error?.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('transcribe prints the transcript when saving fails after the run', async () => {
    const out = join(dir, 'locked.srt');
    writeFileSync(out, 'old');
    chmodSync(out, 0o444);
    const error = await failure(transcribeCommand(ctx(), 'https://example.com/a.mp3', { output: out, force: true }));
    expect(error?.code).toBe('WRITE_FAILED');
    expect(error?.exitCode).toBe(1);
    expect(stdout.text).toContain('Hello there.');
    expect(stdout.text).toContain('00:00:00,100 --> 00:00:00,800');
  });

  it('a language with a region is normalized: pt-BR runs Grok as pt, sw-KE runs Whisper as sw', async () => {
    expect(normalizeLanguage(' pt-BR ')).toBe('pt');
    expect(normalizeLanguage('zh_Hant_TW')).toBe('zh');
    expect(normalizeLanguage('English')).toBe('English');
    await transcribeCommand(ctx(), 'https://example.com/a.mp3', { language: 'pt-BR', output: join(dir, 'pt.srt') });
    expect(calls.at(-1)?.args).toEqual({ modelId: 'xai/grok-speech-to-text', input: { audio: 'https://example.com/a.mp3', timestamps: true, language: 'pt' } });
    await transcribeCommand(ctx(), 'https://example.com/a.mp3', { language: 'sw-KE', output: join(dir, 'sw.srt') });
    expect(calls.at(-1)?.args).toMatchObject({ modelId: 'openai/whisper', input: { language: 'sw' } });
  });

  it('"auto" sends no language (detected, Grok); media over 2 hours is refused before anything is spent', async () => {
    expect(normalizeLanguage('auto')).toBeUndefined();
    expect(normalizeLanguage(' AUTO ')).toBeUndefined();
    expect(sttModelFor('auto')).toBe('xai/grok-speech-to-text');
    await transcribeCommand(ctx(), 'https://example.com/a.mp3', { language: 'auto', output: join(dir, 'auto.srt') });
    expect(calls.at(-1)?.args).toEqual({ modelId: 'xai/grok-speech-to-text', input: { audio: 'https://example.com/a.mp3', timestamps: true } });
    calls = [];
    const error = await failure(transcribeCommand(ctx(), 'https://example.com/media/long-take', { output: join(dir, 'long.srt') }));
    expect(error?.code).toBe('MEDIA_TOO_LONG');
    expect(error?.exitCode).toBe(1);
    expect(error?.message).toContain('about 122 minutes');
    expect(names()).toEqual(['probe_media']);
    calls = [];
    expect((await failure(transcribeCommand(ctx(), 'https://example.com/media/long-take', { dryRun: true })))?.code).toBe('MEDIA_TOO_LONG');
    expect(names()).toEqual(['probe_media']);
  });

  it('a URL without a telling name is probed (free) first: a video is imported and its sound extracted', async () => {
    await transcribeCommand(ctx(), 'https://example.com/media/clip-video', { output: join(dir, 'p.srt') });
    expect(names()).toEqual(['probe_media', 'create_upload_link', 'audio_tools', 'run_model', 'run_model']);
    expect(calls[2]?.args).toEqual({ input: { assetUrl: 'https://cdn.aitopia.ai/imported-video', operation: 'extract' } });
  });

  it('the dry-run price of a probed video includes the extraction; a file with no sound spends nothing', async () => {
    await transcribeCommand(ctx(), 'https://example.com/media/clip-video', { dryRun: true });
    expect(names()).toEqual(['probe_media', 'run_model', 'audio_tools']);
    expect(stdout.text).toContain('to extract the audio');
    calls = [];
    const error = await failure(transcribeCommand(ctx(), 'https://example.com/media/silent', { output: join(dir, 's.srt') }));
    expect(error?.code).toBe('NO_AUDIO');
    expect(names()).toEqual(['probe_media']);
  });

  it('Japanese words are joined without spaces and break after 。', () => {
    const w = (text: string, start: number, end: number) => ({ text, start, end });
    const words = [w('こんにちは', 0, 0.5), w('世界。', 0.5, 1), w('元気', 1.1, 1.4), w('です', 1.4, 1.7)];
    expect(cuesFromWords(words).map((c) => c.text)).toEqual(['こんにちは世界。', '元気です']);
    const thai = cuesOf({ text: '', language: 'th', words: [w('a', 0, 0.2), w('b', 0.2, 0.4)], segments: [] });
    expect(thai[0]?.text).toBe('ab');
  });

  it('wrapCue keeps every line within 42 characters, also when no space balances the lines', () => {
    for (const text of [`${'a'.repeat(40)} ${'b'.repeat(43)}`, 'x'.repeat(80), `${'word '.repeat(16)}end`, 'y'.repeat(130)]) {
      for (const line of wrapCue(text).split('\n')) expect(line.length).toBeLessThanOrEqual(42);
    }
    expect(wrapCue(`${'a'.repeat(40)} ${'b'.repeat(43)}`).split('\n')).toHaveLength(2);
  });

  it('a long Whisper segment is split into several cues by time share', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';
    const cues = splitSegment({ start: 10, end: 20, text });
    expect(cues.length).toBeGreaterThanOrEqual(3);
    expect(cues[0]?.start).toBe(10);
    expect(cues.at(-1)?.end).toBeCloseTo(20);
    for (const [i, cue] of cues.entries()) {
      expect(cue.text.length).toBeLessThanOrEqual(84);
      expect(cue.end - cue.start).toBeLessThanOrEqual(3.5);
      if (i > 0) expect(cue.start).toBeCloseTo(cues[i - 1]?.end ?? 0);
    }
    expect(cues.map((c) => c.text).join(' ')).toBe(text);
  });

  it('a zero-length cue is held half a second, but never past the next cue', () => {
    const w = (text: string, start: number, end: number) => ({ text, start, end });
    expect(buildSrt([w('a', 1, 1), w('b', 1.2, 1.5)])).toContain('00:00:01,000 --> 00:00:01,200');
    expect(buildSrt([w('a', 1, 1), w('b', 3, 3.5)])).toContain('00:00:01,000 --> 00:00:01,500');
  });
});

describe('store agents', () => {
  it('agents lists id, name, listed price and description, pages locally and passes --q', async () => {
    await agentsCommand(ctx(), { limit: 2 });
    expect(calls[0]).toMatchObject({ name: 'list_store_agents', args: {} });
    expect(stdout.text).toMatch(/background-remover\s+Background Remover Pro\s+1 credit\s+Upload any photo/);
    expect(stdout.text).toMatch(/video-upscaler\s+Video Upscaler \(SeedVR2\)\s+40 credits/);
    expect(stdout.text).not.toContain('smart-data-analyzer');
    expect(stderr.text).toContain('Showing 2 of 5. Next page: --offset 2');
    await agentsCommand(ctx(), { offset: 2, limit: 1 });
    expect(stdout.text).toMatch(/smart-data-analyzer\s+Smart Data Analyzer\s+1-5 credits/);
    calls = [];
    await agentsCommand(ctx(true), { q: 'video' });
    expect(calls[0]?.args).toEqual({ q: 'video' });
    const json = JSON.parse(stdout.text) as Record<string, unknown>;
    expect(json).toMatchObject({ returned: 1, total: 1, offset: 0 });
    expect(json.nextOffset).toBeUndefined();
    await agentsCommand(ctx(), { all: true, limit: 1 });
    expect(stdout.text).toContain('viral-image-studio');
    expect(stderr.text).not.toContain('Next page');
  });

  it('agent shows the description, price and fields: file fields, required marks, enums and defaults', async () => {
    await agentShowCommand(ctx(), 'video-upscaler');
    expect(names()).toEqual(['list_store_agents', 'get_store_agent_schema']);
    expect(calls[1]?.args).toEqual({ agentId: 'video-upscaler' });
    expect(stdout.text).toContain('Video Upscaler (SeedVR2) (video-upscaler)');
    expect(stdout.text).toContain('Price: 40 credits');
    expect(stdout.text).toContain('Takes: up to 8 min (runs in the background)');
    expect(stdout.text).toContain('video*  file (video), required');
    expect(stdout.text).toContain('Source Video');
    expect(stdout.text).toContain('target_resolution  string, default "1080p"');
    expect(stdout.text).toContain('one of: "720p", "1080p", "1440p", "2160p"');
    expect(stdout.text).toContain('Run it with: aitopia agent run video-upscaler --set video=<file> --dry-run');
    await agentShowCommand(ctx(true), 'video-upscaler');
    expect(JSON.parse(stdout.text)).toMatchObject({ agent: { id: 'video-upscaler' }, input: { required: ['video'] } });
  });

  it('a name resolves by exact id, then by name in any case; equal names are ambiguous (exit 2); unknown exits 1', async () => {
    await agentShowCommand(ctx(), 'smart DATA analyzer');
    expect(calls[1]?.args).toEqual({ agentId: 'smart-data-analyzer' });
    calls = [];
    await agentShowCommand(ctx(), 'image-generator');
    expect(calls[1]?.args).toEqual({ agentId: 'image-generator' });
    calls = [];
    const ambiguous = await failure(agentShowCommand(ctx(), 'image generator'));
    expect(ambiguous?.exitCode).toBe(2);
    expect(ambiguous?.code).toBe('AMBIGUOUS_NAME');
    expect(ambiguous?.hint).toContain('image-generator (Image Generator), viral-image-studio (Image Generator)');
    const missing = await failure(agentShowCommand(ctx(), 'remover'));
    expect(missing?.exitCode).toBe(1);
    expect(missing?.code).toBe('AGENT_NOT_FOUND');
    expect(missing?.hint).toContain('aitopia agents --q');
    expect(missing?.notes.join(' ')).toContain('background-remover (Background Remover Pro)');
    expect(names()).not.toContain('get_store_agent_schema');
  });

  it('run fits --set values to the field types and prints a text answer', async () => {
    await agentRunCommand(ctx(), 'smart-data-analyzer', { set: ['data=42', 'format=csv', 'hasHeaders=false', 'rows="7"'] });
    expect(names()).toEqual(['list_store_agents', 'get_store_agent_schema', 'run_store_agent']);
    expect(calls[2]?.args).toEqual({ agentId: 'smart-data-analyzer', input: { data: '42', format: 'csv', hasHeaders: false, rows: 7 } });
    expect(stderr.text).toContain('Running Smart Data Analyzer (smart-data-analyzer) · listed price 1-5 credits');
    expect(stdout.text).toContain('"rowCount": 2');
  });

  it('--input (JSON or @file) is merged under --set; a required field with a default is filled in', async () => {
    const file = join(dir, 'input.json');
    writeFileSync(file, JSON.stringify({ data: 'a,b\n1,2', hasHeaders: true }));
    await agentRunCommand(ctx(), 'smart-data-analyzer', { input: `@${file}`, set: ['hasHeaders=false'] });
    expect(calls.at(-1)?.args).toEqual({ agentId: 'smart-data-analyzer', input: { data: 'a,b\n1,2', hasHeaders: false, format: 'csv' } });
    await agentRunCommand(ctx(), 'smart-data-analyzer', { input: '{"data": "x", "format": "json"}' });
    expect(calls.at(-1)?.args).toMatchObject({ input: { data: 'x', format: 'json' } });
    const bad = await failure(agentRunCommand(ctx(), 'smart-data-analyzer', { input: '[1]' }));
    expect(bad?.exitCode).toBe(2);
  });

  it('a local file for a media field is uploaded first, the result is saved with the Open in AITOPIA link', async () => {
    const photo = join(dir, 'product.png');
    writeFileSync(photo, 'png bytes');
    const out = join(dir, 'cutouts');
    await agentRunCommand(ctx(), 'background remover pro', { set: [`photo=${photo}`], output: `${out}/` });
    expect(names()).toEqual(['list_store_agents', 'get_store_agent_schema', 'upload_asset', 'run_store_agent']);
    expect(calls[3]?.args).toEqual({ agentId: 'background-remover', input: { photo: 'https://cdn.aitopia.ai/uploaded.png' } });
    expect(stderr.text).toContain(`Uploading ${photo}...`);
    expect(readdirSync(out)).toHaveLength(1);
    expect(stdout.text).toContain('Saved');
    expect(stdout.text).toContain('Open in AITOPIA: https://aitopia.ai/c/a1');
  });

  it('a local file given to a text or untyped field is refused (exit 2, pass the text); plain text passes', async () => {
    const sheet = join(dir, 'sales.csv');
    writeFileSync(sheet, 'a,b\n1,2');
    const text = await failure(agentRunCommand(ctx(), 'smart-data-analyzer', { set: [`data=${sheet}`] }));
    expect(text?.exitCode).toBe(2);
    expect(text?.message).toContain('The field "data" of store agent smart-data-analyzer takes text, not a file');
    expect(text?.hint).toContain(`--set data="$(cat ${sheet})"`);
    const untyped = await failure(agentRunCommand(ctx(), 'smart-data-analyzer', { set: ['data=x', `notes=${sheet}`] }));
    expect(untyped?.exitCode).toBe(2);
    expect(untyped?.message).toContain('The field "notes"');
    expect(names()).not.toContain('upload_asset');
    expect(names()).not.toContain('run_store_agent');
    await agentRunCommand(ctx(), 'smart-data-analyzer', { set: ['data=report.png'] });
    expect(calls.at(-1)?.args).toMatchObject({ input: { data: 'report.png' } });
  });

  it('a URL field described as media takes a local file (uploaded); a plain URL field does not', async () => {
    const pic = join(dir, 'logo.png');
    writeFileSync(pic, 'png');
    await agentRunCommand(ctx(), 'smart-data-analyzer', { set: ['data=x', `logo=${pic}`], dryRun: true });
    expect(calls.at(-1)?.args).toMatchObject({ input: { logo: DRY_RUN_FILE_URL } });
    const page = await failure(agentRunCommand(ctx(), 'smart-data-analyzer', { set: ['data=x', `website=${pic}`] }));
    expect(page?.exitCode).toBe(2);
  });

  it('--dry-run checks the local file but uploads nothing and runs nothing: only the price is shown', async () => {
    const photo = join(dir, 'product.png');
    writeFileSync(photo, 'png bytes');
    await agentRunCommand(ctx(), 'background-remover', { set: [`photo=${photo}`], dryRun: true });
    expect(names()).toEqual(['list_store_agents', 'get_store_agent_schema', 'run_store_agent']);
    expect(calls[2]?.args).toEqual({ agentId: 'background-remover', input: { photo: DRY_RUN_FILE_URL }, dryRun: true });
    expect(stdout.text).toContain('Estimate: 1 credit');
    expect(stdout.text).toContain('Nothing was submitted or charged.');
    const missingFile = await failure(agentRunCommand(ctx(), 'background-remover', { set: [`photo=${join(dir, 'nope.png')}`], dryRun: true }));
    expect(missingFile?.exitCode).toBe(2);
    expect(names()).not.toContain('upload_asset');
  });

  it('missing required fields and unknown fields stop before any upload or run (exit 2)', async () => {
    const missing = await failure(agentRunCommand(ctx(), 'background-remover', {}));
    expect(missing?.exitCode).toBe(2);
    expect(missing?.message).toBe('Store agent background-remover needs the field "photo".');
    expect(missing?.hint).toContain('--set photo=<file>');
    const unknown = await failure(agentRunCommand(ctx(), 'smart-data-analyzer', { set: ['data=x', 'colour=red'] }));
    expect(unknown?.exitCode).toBe(2);
    expect(unknown?.message).toContain('has no field "colour"');
    expect(names()).toEqual(['list_store_agents', 'get_store_agent_schema', 'list_store_agents', 'get_store_agent_schema']);
    calls = [];
    // A bad --set or --input is found before connecting at all.
    expect((await failure(agentRunCommand(ctx(), 'background-remover', { set: ['nokey'] })))?.exitCode).toBe(2);
    expect((await failure(agentRunCommand(ctx(), 'background-remover', { input: '{oops' })))?.exitCode).toBe(2);
    expect((await failure(agentRunCommand(ctx(), 'background-remover', { folder: 'Banners' })))?.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it('a long run is followed with its runToken to the end and its file downloaded', async () => {
    const out = join(dir, 'up');
    await agentRunCommand(ctx(), 'video-upscaler', { set: ['video=https://example.com/clip.mp4', 'target_resolution=2160p'], output: `${out}/` });
    expect(names()).toEqual(['list_store_agents', 'get_store_agent_schema', 'run_store_agent', 'get_run_status', 'get_run_status']);
    expect(calls[2]?.args).toEqual({ agentId: 'video-upscaler', input: { video: 'https://example.com/clip.mp4', target_resolution: '2160p' } });
    expect(calls[3]?.args).toMatchObject({ runToken: 'agent-1' });
    expect(readdirSync(out)).toHaveLength(1);
    expect(stdout.text).toContain('Open in AITOPIA: https://aitopia.ai/c/a3');
  }, 15_000);

  it('--no-wait returns the run token (exit 5) without polling', async () => {
    const error = await failure(agentRunCommand(ctx(), 'video-upscaler', { set: ['video=https://example.com/clip.mp4'], wait: false }));
    expect(error?.exitCode).toBe(5);
    expect(error?.code).toBe('RUNNING');
    expect(error?.notes).toContain('Check it with: aitopia status agent-1 --wait');
    expect(names()).not.toContain('get_run_status');
  });

  it('--project and --folder are resolved before the run and passed as projectId / folderId', async () => {
    await agentRunCommand(ctx(), 'smart-data-analyzer', { set: ['data=x'], project: 'spring campaign', folder: 'banners' });
    expect(names()).toEqual(['list_store_agents', 'get_store_agent_schema', 'list_projects', 'list_projects', 'list_project_assets', 'run_store_agent']);
    expect(calls.at(-1)?.args).toEqual({ agentId: 'smart-data-analyzer', input: { data: 'x', format: 'csv' }, projectId: 'p-4444', folderId: 'f-1' });
    calls = [];
    const missing = await failure(agentRunCommand(ctx(), 'smart-data-analyzer', { set: ['data=x'], project: 'Nope' }));
    expect(missing?.code).toBe('PROJECT_NOT_FOUND');
    expect(names()).not.toContain('run_store_agent');
  });

  it('a refused input names the agent in the hint; a non-URL value of a file field must be a local file', async () => {
    const error = await failure(agentRunCommand(ctx(), 'background-remover', { set: ['photo=http://example.com/x.png'] }));
    expect(error?.code).toBe('INVALID_INPUT');
    expect(error?.exitCode).toBe(1);
    expect(error?.hint).toContain('aitopia agent background-remover');
    const notFile = await failure(agentRunCommand(ctx(), 'background-remover', { set: ['photo=no-such-thing'] }));
    expect(notFile?.exitCode).toBe(2);
    const notFound = failureToError({ status: 'failed', code: 'NOT_FOUND', error: 'There is no store agent with the id "x".', agentId: 'x', hint: 'Call list_store_agents and use an id it returns.' });
    expect(notFound.hint).toContain('aitopia agents');
    expect(notFound.hint).not.toContain('list_store_agents');
  });

  it('`aitopia agent <id>` routes to show and `aitopia agent run <id>` to run', async () => {
    const program = buildProgram();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    const shown = await program.parseAsync(['node', 'aitopia', 'agent', 'no-such-agent', '--server', `${base}/mcp`]).catch((e: unknown) => e as CliError);
    expect((shown as CliError).code).toBe('AGENT_NOT_FOUND');
    expect(names()).toEqual(['list_store_agents']);
    const run = await buildProgram().parseAsync(['node', 'aitopia', 'agent', 'run', 'background-remover', '--server', `${base}/mcp`]).catch((e: unknown) => e as CliError);
    expect((run as CliError).message).toContain('needs the field "photo"');
  });
});

describe('run limits (account suspension)', () => {
  const TIMED = 'You started too many runs in a short time.\nRuns are paused for this account for a while.';
  const model = { model: 'google/nano-banana-2' };
  const printed = (error: CliError) => {
    const c = ctx();
    printError(c.out, error, false, error);
    return stderr.text;
  };

  it('RUN_LIMITED envelope on a run: exit 6, the message printed verbatim with its line break, called once', async () => {
    imageFailure = { code: 'RUN_LIMITED', upstreamCode: 'QUEUE_LIMIT_EXCEEDED', reason: 'abuse_limit', error: SUSPENDED_TEXT, retryable: false, upgrade: false, hint: 'Tell the user to contact support.' };
    const error = await failure(imageCommand(ctx(), ['fox'], { ...model, output: dir }));
    expect(error?.exitCode).toBe(6);
    expect(error?.code).toBe('RUN_LIMITED');
    expect(error?.message).toBe(SUSPENDED_TEXT);
    expect(names().filter((n) => n === 'generate_image')).toHaveLength(1);
    expect(printed(error as CliError)).toBe(`Error: ${SUSPENDED_TEXT}\n`);
  });

  it('raw runLimit passthrough, timed: minutes and clock time; upgrade true adds the plan link', async () => {
    imageFailure = { runLimit: { code: 'QUEUE_LIMIT_EXCEEDED', reason: 'abuse_limit', error: TIMED, upgrade: true, retryAfterSeconds: 1794 } };
    const error = await failure(imageCommand(ctx(), ['fox'], { ...model, output: dir }));
    expect(error?.exitCode).toBe(6);
    expect(error?.message).toBe(TIMED);
    expect(error?.notes[0]).toMatch(/^You can try again in 30 minutes \(at \d\d:\d\d\)\.$/);
    expect(error?.notes[1]).toBe('Upgrading your AITOPIA plan lifts this limit: https://aitopia.ai/pricing');
    expect(names().filter((n) => n === 'generate_image')).toHaveLength(1);
    const text = printed(error as CliError);
    expect(text).toContain(`Error: ${TIMED}\nYou can try again in 30 minutes`);
  });

  it('--json: status failed, code RUN_LIMITED, the verbatim error, exitCode 6 and the normalized runLimit', async () => {
    imageFailure = { code: 'RUN_LIMITED', reason: 'abuse_limit', error: SUSPENDED_TEXT, retryable: false, upgrade: false };
    const error = (await failure(imageCommand(ctx(true), ['fox'], { ...model, output: dir }))) as CliError;
    const c = ctx(true);
    printError(c.out, error, false, error);
    const body = JSON.parse(stdout.text) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'failed', code: 'RUN_LIMITED', error: SUSPENDED_TEXT, exitCode: 6, runLimit: { reason: 'abuse_limit', upgrade: false } });
  });

  it('a plain QUEUE_LIMIT_EXCEEDED keeps exit 1 and the "too many runs" hint', async () => {
    imageFailure = { code: 'QUEUE_LIMIT_EXCEEDED', error: 'You have 5 runs in progress.', retryable: true };
    const error = await failure(imageCommand(ctx(), ['fox'], { ...model, output: dir }));
    expect(error?.exitCode).toBe(1);
    expect(error?.code).toBe('QUEUE_LIMIT_EXCEEDED');
    expect(error?.hint).toContain('aitopia status');
  });

  it('credits and whoami show the balance and a warning with the verbatim message', async () => {
    balanceRunLimit = { code: 'QUEUE_LIMIT_EXCEEDED', reason: 'abuse_limit', message: SUSPENDED_TEXT, upgrade: false };
    await creditsCommand(ctx());
    expect(stdout.text.trim()).toBe('Credits: 8,951 available');
    expect(stderr.text).toBe(`Warning: ${SUSPENDED_TEXT}\n`);
    await creditsCommand(ctx(), { whoami: true });
    expect(stdout.text).toContain('Signed in to');
    expect(stderr.text).toBe(`Warning: ${SUSPENDED_TEXT}\n`);
    balanceRunLimit = { code: 'QUEUE_LIMIT_EXCEEDED', reason: 'abuse_limit', message: TIMED, retryAfterSeconds: 1794, upgrade: true };
    await creditsCommand(ctx());
    expect(stderr.text).toMatch(/^Warning: You started too many runs in a short time\.\nRuns are paused for this account for a while\.\nYou can try again in 30 minutes \(at \d\d:\d\d\)\.\nUpgrading your AITOPIA plan lifts this limit: https:\/\/aitopia\.ai\/pricing\n$/);
    await creditsCommand(ctx(true));
    expect(JSON.parse(stdout.text).runLimit).toMatchObject({ message: TIMED });
  });

  it('credits without a runLimit prints no warning', async () => {
    await creditsCommand(ctx());
    expect(stderr.text).toBe('');
  });

  it('image --dry-run: "Not available: <message>" instead of Affordable; exit 0', async () => {
    balanceRunLimit = { code: 'QUEUE_LIMIT_EXCEEDED', reason: 'abuse_limit', message: SUSPENDED_TEXT, upgrade: false };
    await imageCommand(ctx(), ['fox'], { ...model, dryRun: true });
    expect(stdout.text).toContain(`Not available: ${SUSPENDED_TEXT}\nNothing was submitted or charged.`);
    expect(stdout.text).not.toContain('Affordable');
    expect(stdout.text).not.toContain('Upgrading');
  });

  it('batch --dry-run shows the balance run limit; edit --dry-run shows it and no run command', async () => {
    balanceRunLimit = { code: 'RUN_LIMITED', reason: 'abuse_limit', message: TIMED, retryAfterSeconds: 120, upgrade: true };
    await batchCommand(ctx(), writeBatch([{ kind: 'image', prompt: 'a fox', modelId: 'google/nano-banana-2' }]), { dryRun: true });
    expect(stdout.text).toContain(`Not available: ${TIMED}\nYou can try again in 2 minutes`);
    expect(stdout.text).toContain('Upgrading your AITOPIA plan lifts this limit: https://aitopia.ai/pricing');
    await editCommand(ctx(), 'https://cdn.aitopia.ai/fox.png', ['remove the background'], { dryRun: true });
    expect(stdout.text).toContain(`Not available: ${TIMED}`);
    expect(stdout.text).not.toContain('Affordable');
    expect(stdout.text).not.toContain('--plan=');
  });

  it('batch: every item run-limited exits 6, generate_batch called once, each item shows the message', async () => {
    const error = await failure(batchCommand(ctx(), writeBatch([{ kind: 'image', prompt: 'a', modelId: 'banned/x' }, { kind: 'image', prompt: 'b', modelId: 'banned/x' }]), {}));
    expect(error?.exitCode).toBe(6);
    expect(error?.code).toBe('RUN_LIMITED');
    expect(names()).toEqual(['generate_batch']);
    expect(stderr.text).toContain(`: ${SUSPENDED_TEXT}`);
  });

  it('status: a run that ends run-limited is reported once (exit 6), never asked again', async () => {
    runStates['lim-1'] = [{ status: 'failed', code: 'RUN_LIMITED', reason: 'abuse_limit', error: SUSPENDED_TEXT, retryable: true, retryAfterSeconds: 30, upgrade: false }];
    const error = await failure(statusCommand(ctx(), ['lim-1'], { wait: true, output: dir }));
    expect(error?.exitCode).toBe(6);
    expect(error?.message).toBe(SUSPENDED_TEXT);
    expect(names().filter((n) => n === 'get_run_status')).toHaveLength(1);
  });
});

describe('named edit tools', () => {
  it('upscale: an image runs upscale_image with --scale; a local file is uploaded first and saved as <name>-upscaled', async () => {
    const photo = join(dir, 'photo.png');
    writeFileSync(photo, 'png');
    const out = join(dir, 'up');
    await upscaleCommand(ctx(), photo, { scale: '4', output: `${out}/` });
    expect(names()).toEqual(['upload_asset', 'upscale_image']);
    expect(calls[1]?.args).toEqual({ assetUrl: 'https://cdn.aitopia.ai/uploaded.png', scale: 4 });
    expect(calls[1]?.progressToken).toBeDefined();
    expect(readdirSync(out)).toEqual(['photo-upscaled.png']);
  });

  it('upscale: a video runs upscale_video with --resolution and follows its run token', async () => {
    const out = join(dir, 'upv');
    await upscaleCommand(ctx(), 'https://cdn.aitopia.ai/clip.mp4', { resolution: '2160p', output: `${out}/` });
    expect(names()).toEqual(['upscale_video', 'get_run_status']);
    expect(calls[0]?.args).toEqual({ assetUrl: 'https://cdn.aitopia.ai/clip.mp4', targetResolution: '2160p' });
    expect(readdirSync(out)).toEqual(['clip-upscaled.mp4']);
  }, 15_000);

  it('upscale: a URL that does not tell its type is probed (free) first; wrong flags stop before connecting', async () => {
    await upscaleCommand(ctx(), 'https://example.com/media/still', { dryRun: true });
    expect(names()).toEqual(['probe_media', 'upscale_image']);
    expect(calls[1]?.args).toEqual({ assetUrl: 'https://example.com/media/still', dryRun: true });
    expect(stdout.text).toContain('Estimate: 8 credits');
    calls = [];
    expect((await failure(upscaleCommand(ctx(), 'https://cdn.aitopia.ai/a.png', { resolution: '2160p' })))?.exitCode).toBe(2);
    expect((await failure(upscaleCommand(ctx(), 'https://cdn.aitopia.ai/a.mp4', { scale: '4' })))?.exitCode).toBe(2);
    expect((await failure(upscaleCommand(ctx(), 'https://cdn.aitopia.ai/a.mp3', {})))?.exitCode).toBe(2);
    expect((await failure(upscaleCommand(ctx(), 'https://cdn.aitopia.ai/a.png', { scale: '3' })))?.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it('remove-bg passes the project, the name and --json; a video is refused before connecting', async () => {
    await removeBgCommand(ctx(true), 'https://cdn.aitopia.ai/product.jpg', { project: 'Podcast', name: 'Cut', output: `${join(dir, 'rb')}/` });
    expect(calls.find((c) => c.name === 'remove_background')?.args).toEqual({ assetUrl: 'https://cdn.aitopia.ai/product.jpg', projectId: 'p-1111', assetName: 'Cut' });
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'completed' });
    calls = [];
    const error = await failure(removeBgCommand(ctx(), 'https://cdn.aitopia.ai/clip.mp4', {}));
    expect(error?.exitCode).toBe(2);
    expect(error?.message).toContain('takes an image');
    expect(calls).toEqual([]);
  });

  it('outpaint: --aspect or pixels per side (not both, not neither); --prompt goes along', async () => {
    await outpaintCommand(ctx(), 'https://cdn.aitopia.ai/beach.png', { left: 300, right: 300, prompt: 'more sand', dryRun: true });
    expect(calls[0]?.args).toEqual({ assetUrl: 'https://cdn.aitopia.ai/beach.png', expand: { left: 300, right: 300 }, prompt: 'more sand', dryRun: true });
    calls = [];
    await outpaintCommand(ctx(), 'https://cdn.aitopia.ai/beach.png', { aspect: '16:9', dryRun: true });
    expect(calls[0]?.args).toEqual({ assetUrl: 'https://cdn.aitopia.ai/beach.png', aspectRatio: '16:9', dryRun: true });
    calls = [];
    expect((await failure(outpaintCommand(ctx(), 'https://cdn.aitopia.ai/beach.png', {})))?.exitCode).toBe(2);
    expect((await failure(outpaintCommand(ctx(), 'https://cdn.aitopia.ai/beach.png', { aspect: '1:1', top: 10 })))?.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it('reframe needs --aspect and names the file after the ratio', async () => {
    expect((await failure(reframeCommand(ctx(), 'https://cdn.aitopia.ai/clip.mp4', {})))?.exitCode).toBe(2);
    const out = join(dir, 'rf');
    await reframeCommand(ctx(), 'https://cdn.aitopia.ai/clip.mp4', { aspect: '9:16', output: `${out}/` });
    expect(calls[0]?.args).toEqual({ assetUrl: 'https://cdn.aitopia.ai/clip.mp4', aspectRatio: '9:16' });
    expect(readdirSync(out)).toEqual(['clip-9x16.mp4']);
  }, 15_000);

  it('motion uploads both local files and sends mode and prompt', async () => {
    const image = join(dir, 'me.png');
    const video = join(dir, 'dance.mp4');
    writeFileSync(image, 'png');
    writeFileSync(video, 'mp4');
    await motionCommand(ctx(), image, video, { mode: 'replace', prompt: 'on a stage', dryRun: true });
    expect(names()).toEqual(['upload_asset', 'upload_asset', 'motion_control']);
    expect(calls[2]?.args).toEqual({
      characterImageUrl: 'https://cdn.aitopia.ai/uploaded.png',
      referenceVideoUrl: 'https://cdn.aitopia.ai/uploaded.png',
      prompt: 'on a stage',
      mode: 'replace',
      dryRun: true,
    });
    calls = [];
    expect((await failure(motionCommand(ctx(), video, image, {})))?.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it('voice-change: a preset in any case, --denoise, and the steps of a video shown on --dry-run', async () => {
    await voiceChangeCommand(ctx(), 'https://cdn.aitopia.ai/talk.mp4', { voice: 'aria', denoise: true, dryRun: true });
    expect(calls[0]?.args).toEqual({ assetUrl: 'https://cdn.aitopia.ai/talk.mp4', presetVoice: 'Aria', removeBackgroundNoise: true, dryRun: true });
    expect(stdout.text).toContain('1. Extract audio (ffmpeg) · 1 credit');
    expect(stdout.text).toContain('Estimate: 8 credits');
    calls = [];
    const error = await failure(voiceChangeCommand(ctx(), 'https://cdn.aitopia.ai/talk.mp3', { voice: 'Morgan' }));
    expect(error?.exitCode).toBe(2);
    expect(error?.message).toContain('not a preset voice');
    expect(error?.hint).toContain('aitopia audio');
    expect(calls).toEqual([]);
  });

  it('a run that stops part way exits 1 and names the last finished file', async () => {
    const error = await failure(voiceChangeCommand(ctx(), 'https://cdn.aitopia.ai/partial.mp3', {}));
    expect(error?.exitCode).toBe(1);
    expect(error?.message).toBe('Step 3 failed: mux failed');
    expect(error?.notes).toContain('Last finished file: https://cdn.aitopia.ai/changed-voice.mp3');
  });
});

describe('upload into a project', () => {
  it('upload --project/--folder resolves the names and sends projectId/folderId with each upload', async () => {
    const { uploadCommand } = await import('../src/commands/upload.js');
    const small = join(dir, 'small.png');
    writeFileSync(small, 'png');
    await uploadCommand(ctx(true), [small, 'https://example.com/clip.mp4'], { project: 'Spring campaign', folder: 'Banners' });
    expect(calls.find((c) => c.name === 'upload_asset')?.args).toMatchObject({ fileName: 'small.png', projectId: 'p-4444', folderId: 'f-1' });
    expect(calls.find((c) => c.name === 'create_upload_link')?.args).toEqual({ sourceUrl: 'https://example.com/clip.mp4', projectId: 'p-4444', folderId: 'f-1' });
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'completed' });
    calls = [];
    const missing = await failure(uploadCommand(ctx(), [small], { project: 'Nope' }));
    expect(missing?.code).toBe('PROJECT_NOT_FOUND');
    expect(names()).not.toContain('upload_asset');
    calls = [];
    expect((await failure(uploadCommand(ctx(), [small], { folder: 'Banners' })))?.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('shellWord', () => {
  it('POSIX: plain words as is, others in single quotes', () => {
    expect(shellWord('/tmp/fox.png', false)).toBe('/tmp/fox.png');
    expect(shellWord("it's red", false)).toBe(`'it'\\''s red'`);
  });

  it('Windows: backslash paths as is, spaces in double quotes, expandable characters in single quotes', () => {
    expect(shellWord('C:\\Users\\RUNNER~1\\fox.png', true)).toBe('"C:\\Users\\RUNNER~1\\fox.png"');
    expect(shellWord('C:\\Users\\ann\\fox.png', true)).toBe('C:\\Users\\ann\\fox.png');
    expect(shellWord('C:\\My Photos\\fox.png', true)).toBe('"C:\\My Photos\\fox.png"');
    expect(shellWord('remove the background', true)).toBe('"remove the background"');
    expect(shellWord("50% off, it's $5", true)).toBe("'50% off, it''s $5'");
  });
});
