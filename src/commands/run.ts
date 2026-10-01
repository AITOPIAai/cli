import { parseRunArgs, type RunArgOptions } from '../args.js';
import { withSession, type Context } from '../context.js';
import { UsageError } from '../errors.js';
import type { Session, ToolInfo } from '../mcp.js';
import { deliver, deliverEstimate, settle, startActivity, type DeliverOptions } from '../results.js';
import { paidCall } from './generate.js';

export type RunOptions = RunArgOptions & DeliverOptions & { dryRun?: boolean };

/** Whether a tool's input schema declares `dryRun` (tools without it would ignore the flag and really run). */
export function supportsDryRun(tool: ToolInfo | undefined): boolean {
  const properties = tool?.inputSchema?.properties;
  return Boolean(properties && typeof properties === 'object' && 'dryRun' in properties);
}

async function checkDryRun(session: Session, tool: string): Promise<void> {
  const info = (await session.listTools()).find((t) => t.name === tool);
  if (!info) throw new UsageError(`Unknown tool: ${tool}`, 'List tools with `aitopia tools`.');
  if (!supportsDryRun(info)) {
    throw new UsageError(`${tool} has no price check, so --dry-run cannot be used with it. Nothing was sent.`);
  }
}

export async function runCommand(ctx: Context, tool: string, options: RunOptions): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+$/.test(tool)) throw new UsageError(`Invalid tool name: ${tool}`, 'List tools with `aitopia tools`.');
  const args = parseRunArgs(options);
  if (options.dryRun) args.dryRun = true;
  await withSession(ctx, async (session) => {
    if (options.dryRun) await checkDryRun(session, tool);
    ctx.out.debug(`calling ${tool}`);
    const activity = startActivity(ctx, options.dryRun ? 'Checking the price' : `Running ${tool}`);
    try {
      const first = await paidCall(options.dryRun, () => session.callTool(tool, args, { ...activity.callOptions, paid: !options.dryRun }));
      if (options.dryRun) {
        activity.stop();
        deliverEstimate(ctx, first);
        return;
      }
      const done = await settle(ctx, session, first, `Running ${tool}`, activity);
      await deliver(ctx, done, options, { showPayload: true });
    } finally {
      activity.stop();
    }
  });
}
