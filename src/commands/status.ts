import { withSession, type Context } from '../context.js';
import type { ToolOutcome } from '../envelope.js';
import { UsageError } from '../errors.js';
import { describeProgress } from '../output.js';
import { isRunning, MAX_RUN_TOKENS, POLL_WAIT_SEC, progressOf } from '../poll.js';
import { deliver, settle, startActivity, type DeliverOptions } from '../results.js';
import { directoryTarget, finishItems, followItems, type RunItem } from '../runs.js';

export interface StatusOptions extends DeliverOptions {
  wait?: boolean;
}

export async function statusCommand(ctx: Context, runTokens: string[] | string, options: StatusOptions): Promise<void> {
  const tokens = [...new Set((Array.isArray(runTokens) ? runTokens : [runTokens]).map((t) => t.trim()).filter(Boolean))];
  if (tokens.length === 0) throw new UsageError('A run token is required.');
  if (tokens.length > MAX_RUN_TOKENS) throw new UsageError(`Check at most ${MAX_RUN_TOKENS} run tokens at once; got ${tokens.length}.`);
  if (tokens.length === 1) return statusOne(ctx, tokens[0] as string, options);
  return statusMany(ctx, tokens, options);
}

async function statusOne(ctx: Context, token: string, options: StatusOptions): Promise<void> {
  await withSession(ctx, async (session) => {
    const activity = startActivity(ctx, 'Waiting for the run');
    try {
      // With --wait the first call already long-polls on the server.
      const args = options.wait ? { runToken: token, wait: POLL_WAIT_SEC } : { runToken: token };
      const first = await session.callTool('get_run_status', args, options.wait ? activity.callOptions : undefined);
      // get_run_status answers without the token; keep it so polling can continue.
      const current: ToolOutcome = { ...first, payload: { runToken: token, ...first.payload } };
      if (isRunning(current) && !options.wait) {
        activity.stop();
        const { out } = ctx;
        if (out.jsonMode) {
          out.json(current.payload);
          return;
        }
        const detail = describeProgress(progressOf(token, current));
        out.line(`Still running${detail ? ` (${detail})` : ''}.`);
        if (typeof current.payload.note === 'string') out.note(current.payload.note);
        out.line(`Wait for it with: aitopia status ${token} --wait`);
        return;
      }
      const done = await settle(ctx, session, current, 'Waiting for the run', activity);
      await deliver(ctx, done, options);
    } finally {
      activity.stop();
    }
  });
}

async function statusMany(ctx: Context, tokens: string[], options: StatusOptions): Promise<void> {
  const target = directoryTarget(options.output);
  await withSession(ctx, async (session) => {
    const items: RunItem[] = tokens.map((runToken, index) => ({
      index,
      label: `run ${index + 1}`,
      runToken,
      status: 'running',
      payload: {},
      files: [],
      assetUrls: [],
    }));
    await followItems(ctx, session, items, { ...options, target, total: items.length }, {
      untilDone: options.wait === true,
      label: 'Checking the runs',
    });
    if (!options.wait && !ctx.out.jsonMode) {
      for (const item of items.filter((i) => i.status === 'running')) {
        const detail = describeProgress(progressOf(item.runToken as string, { payload: item.payload, isError: false, links: [] }));
        ctx.out.line(`${item.label}: still running${detail ? ` (${detail})` : ''}`);
      }
    }
    finishItems(ctx, items, { noun: 'run', runningIsOk: !options.wait });
  });
}
