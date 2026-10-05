import { withSession, type Context } from '../context.js';
import { failureToError, formatNumber, runLimitOf, safeHost } from '../errors.js';
import { warnRunLimit } from '../results.js';
import { buyCreditsUrl, isFailed } from '../envelope.js';

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The balance generations spend. `creditsForGeneration` decides ("unlimited"
 * or a number): on agent-scoped plans the account fields read unlimited while
 * generations draw from a capped agent balance. The account-level
 * unlimited / -999 flags count only when that field is missing.
 */
export function spendableCredits(payload: Record<string, unknown>): number | 'unlimited' | undefined {
  const forGeneration = payload.creditsForGeneration;
  if (typeof forGeneration === 'string' && forGeneration.toLowerCase() === 'unlimited') return 'unlimited';
  const n = num(forGeneration);
  if (n !== undefined) return n;
  if (payload.unlimited === true || payload.totalCredits === -999) return 'unlimited';
  return num(payload.totalCredits);
}

export function isUnlimited(payload: Record<string, unknown>): boolean {
  return spendableCredits(payload) === 'unlimited';
}

/** "Credits: 8,951 available for generation" (+ the account breakdown when it applies). */
export function creditsLine(payload: Record<string, unknown>): string {
  const spendable = spendableCredits(payload);
  if (spendable === 'unlimited') return 'Credits: unlimited';
  if (spendable === undefined) return 'Credits: unknown';
  const head = `Credits: ${formatNumber(spendable)} available`;
  // The paid/daily split describes the account balance; show it only when that
  // is the balance generations spend (no separate agent balance).
  if (payload.agentBalance !== undefined || payload.unlimited === true) return head;
  const parts: string[] = [];
  const paid = num(payload.paidCreditsBalance);
  const daily = num(payload.dailyCreditsRemaining);
  if (paid !== undefined) parts.push(`${formatNumber(paid)} paid`);
  if (daily !== undefined) parts.push(`${formatNumber(daily)} daily left`);
  return parts.length > 0 ? `${head} (${parts.join(', ')})` : head;
}

export async function creditsCommand(ctx: Context, options: { whoami?: boolean } = {}): Promise<void> {
  await withSession(ctx, async (session) => {
    const outcome = await session.callTool('get_credit_balance', {});
    if (isFailed(outcome)) throw failureToError(outcome.payload, { buyCreditsUrl: buyCreditsUrl(outcome) });
    const { out } = ctx;
    if (out.jsonMode) {
      out.json({ server: ctx.serverUrl, ...outcome.payload });
      return;
    }
    if (options.whoami) out.line(`Signed in to ${safeHost(ctx.serverUrl)}.`);
    out.line(creditsLine(outcome.payload));
    const runLimit = runLimitOf(outcome.payload);
    if (runLimit) warnRunLimit(out, runLimit, buyCreditsUrl(outcome));
  });
}
