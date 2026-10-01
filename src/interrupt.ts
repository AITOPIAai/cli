import { cleanupTempFiles } from './download.js';
import { EXIT, interruptNotes } from './errors.js';
import type { Output } from './output.js';

let activeRunTokens: string[] = [];
let requestInFlight = false;

/** A finished result: paid for, maybe not downloaded yet. */
export interface ReadyResult {
  assetUrl: string;
  name?: string;
  openInAitopia?: string;
  /** Set once it was saved. */
  file?: string;
  /** "item 2" in a batch */
  label?: string;
}

const readyResults: ReadyResult[] = [];

/** Remembers a finished result so Ctrl+C can still say where it is. Returns the entry (set `file` once saved). */
export function addReadyResult(result: ReadyResult): ReadyResult {
  const existing = readyResults.find((r) => r.assetUrl === result.assetUrl);
  if (existing) return existing;
  readyResults.push(result);
  return result;
}

export function readyResultsSnapshot(): ReadyResult[] {
  return readyResults.map((r) => ({ ...r }));
}

export function clearReadyResults(): void {
  readyResults.length = 0;
}

/** Lines naming every finished result (saved, or its URL). */
export function readyNotes(results: ReadyResult[]): string[] {
  if (results.length === 0) return [];
  const lines = ['Finished results (already paid for, do not generate them again):'];
  for (const r of results) {
    const head = r.label ? `${r.label}: ` : '';
    lines.push(r.file ? `  ${head}saved ${r.file}` : `  ${head}${r.name ? `${r.name} ` : ''}${r.assetUrl}`);
  }
  const open = [...new Set(results.map((r) => r.openInAitopia).filter((u): u is string => Boolean(u)))];
  for (const url of open) lines.push(`  Open in AITOPIA: ${url}`);
  return lines;
}

/** The run(s) being waited for, reported if the user presses Ctrl+C. */
export function setActiveRun(runToken: string | string[] | undefined): void {
  activeRunTokens = runToken === undefined ? [] : Array.isArray(runToken) ? [...runToken] : [runToken];
}

/** Marks a (possibly charged) tool call as sent and not yet answered. */
export function setRequestInFlight(value: boolean): void {
  requestInFlight = value;
}

/** Runs `fn` while marked as in flight. */
export async function inFlight<T>(fn: () => Promise<T>): Promise<T> {
  setRequestInFlight(true);
  try {
    return await fn();
  } finally {
    setRequestInFlight(false);
  }
}

/** What Ctrl+C prints: finished results (saved or not) and how to pick up runs still going. */
export function reportInterrupt(out: Output): void {
  const tokens = activeRunTokens;
  const ready = readyResultsSnapshot();
  if (out.jsonMode) {
    const ids = tokens.length === 1 ? { runToken: tokens[0] } : tokens.length > 1 ? { runTokens: tokens } : {};
    out.json({ status: 'interrupted', ...ids, ...(ready.length > 0 ? { ready } : {}) });
  }
  out.note('');
  out.note('Interrupted.');
  for (const line of readyNotes(ready)) out.note(line);
  if (tokens.length > 0 || requestInFlight) for (const line of interruptNotes(tokens)) out.note(line);
}

/**
 * Ctrl+C stops waiting (the run itself keeps going on the server), prints how
 * to pick it up again, lists finished results, removes partial downloads and
 * exits with 130.
 */
export function installInterruptHandler(out: Output): void {
  const onSignal = () => {
    cleanupTempFiles();
    reportInterrupt(out);
    process.exit(EXIT.INTERRUPTED);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', cleanupTempFiles);
}
