import { randomBytes } from 'node:crypto';
import type { RunProgress } from './poll.js';

type Env = Record<string, string | undefined>;

interface Stream {
  write(chunk: string): boolean;
  isTTY?: boolean;
  columns?: number;
}

/** Colors only on a TTY and never when NO_COLOR is set (https://no-color.org). */
export function colorEnabled(stream: Stream, env: Env = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return stream.isTTY === true;
}

export interface Palette {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

/**
 * Our own colors are written as a per-process marker and turned into escape
 * codes only after the text was cleaned, so server-provided text can never
 * carry (or fake) terminal escape sequences.
 */
const COLOR_MARK = `\uE000${randomBytes(6).toString('hex')}:`;
const COLOR_MARK_PATTERN = new RegExp(`${COLOR_MARK}(\\d{1,3})m`, 'g');

function paint(enabled: boolean, open: number, close: number): (s: string) => string {
  return enabled ? (s) => `${COLOR_MARK}${open}m${s}${COLOR_MARK}${close}m` : (s) => s;
}

// ESC sequences: CSI (ESC [ ... final), OSC (ESC ] ... BEL or ESC \\), and any other ESC + one char.
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[\s\S]?/g;
// C0 controls except tab and newline, DEL, and C1 controls (incl. single-byte CSI/OSC).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Removes terminal control sequences from text meant for a terminal (keeps \\n and \\t). */
export function stripControl(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, '').replace(CONTROL_CHARS, '');
}

/** JSON with DEL and C1 controls escaped too (JSON.stringify leaves them raw). */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Cleans text for the terminal, then applies our own color markers. */
export function renderForTerminal(text: string): string {
  return stripControl(text).replace(COLOR_MARK_PATTERN, (_m, code: string) => `\u001b[${code}m`);
}

export function palette(enabled: boolean): Palette {
  return {
    bold: paint(enabled, 1, 22),
    dim: paint(enabled, 2, 22),
    red: paint(enabled, 31, 39),
    green: paint(enabled, 32, 39),
    yellow: paint(enabled, 33, 39),
    cyan: paint(enabled, 36, 39),
  };
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/** "~45 s left", "~3 min left"; empty when there is no estimate. */
export function formatEta(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.max(1, Math.round(seconds));
  return s < 120 ? `~${s} s left` : `~${Math.round(s / 60)} min left`;
}

export function describeProgress(
  p: Pick<RunProgress, 'progress' | 'queuePosition' | 'etaSeconds'>,
  options: { eta?: boolean } = {},
): string {
  const parts: string[] = [];
  if (typeof p.queuePosition === 'number' && p.queuePosition > 0) parts.push(`queue position ${p.queuePosition}`);
  if (typeof p.progress === 'number') parts.push(`${Math.round(p.progress)}%`);
  const eta = options.eta === false ? '' : formatEta(p.etaSeconds);
  if (eta) parts.push(eta);
  return parts.join(', ');
}

/** The server's progress text without its own elapsed counter ("… — 9 s"); the spinner shows elapsed time. */
export function progressMessage(message: string | undefined): string {
  if (typeof message !== 'string') return '';
  return stripControl(message)
    .replace(/\s+[—–-]\s+\d+\s*s$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export interface Spinner {
  update(detail: string): void;
  /** Replaces the label (e.g. with the server's progress message). */
  setLabel(label: string): void;
  /** Counts down from this many seconds (undefined clears it). */
  setEta(seconds: number | undefined): void;
  stop(): void;
}

const FRAMES = ['|', '/', '-', '\\'];

/**
 * Human output goes to stdout; progress, warnings and diagnostics to stderr.
 * In --json mode stdout carries exactly one JSON object (see `json`).
 */
export class Output {
  readonly jsonMode: boolean;
  readonly verbose: boolean;
  readonly out: Palette;
  readonly err: Palette;
  private readonly stdout: Stream;
  private readonly stderr: Stream;
  private spinnerActive = false;

  constructor(opts: { json?: boolean; verbose?: boolean; stdout?: Stream; stderr?: Stream; env?: Env } = {}) {
    this.jsonMode = opts.json === true;
    this.verbose = opts.verbose === true;
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
    const env = opts.env ?? process.env;
    this.out = palette(colorEnabled(this.stdout, env));
    this.err = palette(colorEnabled(this.stderr, env));
  }

  /** A result line (stdout in human mode; stderr in --json mode so stdout stays JSON). */
  line(text = ''): void {
    this.clearSpinnerLine();
    if (this.jsonMode) this.stderr.write(`${renderForTerminal(text)}\n`);
    else this.stdout.write(`${renderForTerminal(text)}\n`);
  }

  /** Progress and notes: always stderr. */
  note(text: string): void {
    this.clearSpinnerLine();
    this.stderr.write(`${renderForTerminal(text)}\n`);
  }

  warn(text: string): void {
    this.note(this.err.yellow(`Warning: ${text}`));
  }

  debug(text: string): void {
    if (this.verbose) this.note(this.err.dim(text));
  }

  /** The single JSON object of --json mode. */
  json(value: unknown): void {
    this.stdout.write(`${safeJson(value)}\n`);
  }

  get stderrIsTTY(): boolean {
    return this.stderr.isTTY === true;
  }

  get columns(): number {
    return this.stdout.columns ?? 100;
  }

  /** Spinner with elapsed time on a TTY; plain lines on change otherwise. */
  spinner(label: string, now: () => number = Date.now): Spinner {
    const started = now();
    let detail = '';
    let etaAt: number | undefined;
    if (!this.stderrIsTTY) {
      this.stderr.write(`${renderForTerminal(label)}\n`);
      let last = '';
      return {
        update: (d) => {
          if (d && d !== last) {
            last = d;
            this.stderr.write(`  ${renderForTerminal(d)}\n`);
          }
        },
        setLabel: () => undefined,
        setEta: () => undefined,
        stop: () => undefined,
      };
    }
    let frame = 0;
    let stopped = false;
    const render = () => {
      const elapsed = formatDuration(now() - started);
      const eta = etaAt !== undefined ? formatEta((etaAt - now()) / 1000) : '';
      const extra = [detail, eta].filter(Boolean).join(', ');
      const text = `${FRAMES[frame++ % FRAMES.length]} ${label} ${this.err.dim(`${elapsed}${extra ? ` - ${extra}` : ''}`)}`;
      this.stderr.write(`\r\u001b[2K${renderForTerminal(text)}`);
      this.spinnerActive = true;
    };
    render();
    const timer = setInterval(render, 120);
    timer.unref();
    return {
      update: (d) => {
        detail = d;
      },
      setLabel: (l) => {
        if (l) label = l;
      },
      setEta: (seconds) => {
        etaAt = typeof seconds === 'number' && seconds > 0 ? now() + seconds * 1000 : undefined;
      },
      stop: () => {
        clearInterval(timer);
        if (stopped) return;
        stopped = true;
        this.clearSpinnerLine();
      },
    };
  }

  private clearSpinnerLine(): void {
    if (this.spinnerActive) {
      this.stderr.write('\r\u001b[2K');
      this.spinnerActive = false;
    }
  }
}

/** Pads columns; the last column is not padded. */
export function renderTable(rows: string[][], maxWidths: number[] = []): string[] {
  const clip = (value: string, max: number | undefined) =>
    max && value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
  const clipped = rows.map((row) => row.map((cell, i) => clip(cell, maxWidths[i])));
  const widths: number[] = [];
  for (const row of clipped) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return clipped.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
}
