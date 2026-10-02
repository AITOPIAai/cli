import { createInterface } from 'node:readline/promises';
import type { Context } from './context.js';
import { CliError, EXIT, UsageError } from './errors.js';

/** Asks on the terminal (stdin + stderr); undefined when either is not a terminal. */
export async function askOnTerminal(question: string): Promise<boolean | undefined> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * A destructive action goes ahead with --yes, or when the user answers yes on
 * a terminal. Without a terminal (scripts, --json) and without --yes it is
 * refused (exit 2) instead of guessing. Returns false when the user said no.
 */
export async function confirmAction(
  ctx: Context,
  prompt: { question: string; action: string },
  yes: boolean | undefined,
): Promise<boolean> {
  if (yes) return true;
  let answer: boolean | undefined;
  if (!ctx.out.jsonMode) answer = ctx.confirm ? await ctx.confirm(prompt.question) : await askOnTerminal(prompt.question);
  if (answer === undefined) throw new UsageError(`Add --yes to ${prompt.action}: there is no terminal to ask on.`);
  return answer;
}

/** The user answered no: exit 1 with `message` (e.g. "Not deleted."), nothing was done. */
export function notConfirmed(message: string): CliError {
  return new CliError(message, EXIT.FAILED, { code: 'NOT_CONFIRMED', hint: 'You answered no; nothing was changed or charged.' });
}
