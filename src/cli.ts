#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import { collect, parseIntegerOption } from './args.js';
import { createContext, type GlobalOptions } from './context.js';
import { CliError, EXIT, toCliError } from './errors.js';
import { installInterruptHandler } from './interrupt.js';
import { Output } from './output.js';
import { VERSION } from './version.js';
import { audioCommand } from './commands/audio.js';
import { batchCommand } from './commands/batch.js';
import { creditsCommand } from './commands/credits.js';
import { imageCommand } from './commands/image.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { modelCommand, modelsCommand, MODEL_TYPES } from './commands/models.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { toolsCommand } from './commands/tools.js';
import { uploadCommand } from './commands/upload.js';
import { videoCommand } from './commands/video.js';

type Action = (globals: GlobalOptions, ...args: unknown[]) => Promise<void>;

/** Wraps a command so it receives the global options merged with its own. */
function action(fn: Action) {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const globals = command.optsWithGlobals<GlobalOptions>();
    await fn(globals, ...args.slice(0, -1));
  };
}

const DRY_RUN_HELP = 'show the price and your balance; nothing is submitted or charged';

function addDeliveryOptions(command: Command): Command {
  return command
    .option('-o, --output <path>', 'file or directory to save to (default: current directory)')
    .option('--force', 'overwrite existing files')
    .option('--no-download', 'print the file URLs instead of downloading');
}

const EXAMPLES = `
Examples:
  $ aitopia login
  $ aitopia image "a red fox in fresh snow, golden hour" --aspect 16:9
  $ aitopia image "minimal logo of a paper boat" -n 3 -o logos/
  $ aitopia video "the fox turns its head and blinks" --image fox.png
  $ aitopia audio "Welcome to AITOPIA." -o welcome.mp3
  $ aitopia video "slow pan over a harbor" --duration 10 --dry-run
  $ aitopia batch shots.json -o shots/
  $ aitopia status <runToken> <runToken> --wait
  $ aitopia upload photo.jpg clip.mp4
  $ aitopia run list_connections
  $ aitopia credits --json

Exit codes: 0 ok, 1 failed, 2 usage error, 3 not signed in, 4 not enough credits,
5 submitted but outcome unknown (check with \`aitopia status <runToken>\`), 130 interrupted.
--dry-run prints the price and exits 0, also when your balance is short (it says so).
--help and --version always print text, also with --json.
Docs: https://github.com/AITOPIAai/cli#readme`;

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('aitopia')
    .description('AITOPIA from the command line: generate images, video and audio, run tools, download results.')
    .version(VERSION, '-V, --version', 'print the version')
    .option('--json', 'print one JSON object on stdout (progress goes to stderr)')
    .option('--verbose', 'log requests to stderr (tokens are never shown)')
    .option('--server <url>', 'AITOPIA MCP server URL (default: $AITOPIA_MCP_URL or https://mcp.aitopia.ai/mcp)')
    .helpOption('-h, --help', 'show help')
    .showHelpAfterError('(run with --help for usage)')
    .exitOverride()
    .addHelpText('after', EXAMPLES);

  program
    .command('login')
    .description('sign in with your AITOPIA account (opens a browser)')
    .option('--no-browser', 'print the sign-in link instead of opening a browser')
    .action(action((g, opts) => loginCommand(createContext(g), opts as { browser?: boolean })));

  program
    .command('logout')
    .description('sign out and remove the local sign-in')
    .action(action((g) => logoutCommand(createContext(g))));

  program
    .command('whoami')
    .description('show the signed-in server and your credits')
    .action(action((g) => creditsCommand(createContext(g), { whoami: true })));

  program
    .command('credits')
    .description('show your credit balance')
    .action(action((g) => creditsCommand(createContext(g))));

  program
    .command('models')
    .description('list models')
    .addOption(new Option('--type <type>', 'media type').choices(MODEL_TYPES))
    .option('--q <text>', 'search by name or capability')
    .option('--limit <n>', 'how many to show (1-100)', parseIntegerOption('--limit', 1, 100))
    .option('--offset <n>', 'skip this many (paging)', parseIntegerOption('--offset', 0, 100_000))
    .option('--all', 'include models outside the recommended set')
    .action(action((g, opts) => modelsCommand(createContext(g), opts as Parameters<typeof modelsCommand>[1])));

  program
    .command('model')
    .description("show a model's input fields")
    .argument('<id>', 'model id from `aitopia models`')
    .action(action((g, id) => modelCommand(createContext(g), id as string)));

  addDeliveryOptions(
    program
      .command('image')
      .description('generate images')
      .argument('<prompt...>', 'what to create')
      .option('--model <id>', 'model id (default: a current AITOPIA image model, printed on use)')
      .option('--aspect <ratio>', "aspect ratio, e.g. 1:1, 16:9 (mapped to the model's own field)")
      .option('-n, --count <n>', 'number of images (1-4)', parseIntegerOption('--count', 1, 4))
      .option('--name <name>', 'name for the saved asset')
      .option('--set <key=value>', 'extra model field (repeatable, value parsed as JSON)', collect)
      .option('--dry-run', DRY_RUN_HELP),
  ).action(action((g, words, opts) => imageCommand(createContext(g), words as string[], opts as Parameters<typeof imageCommand>[2])));

  addDeliveryOptions(
    program
      .command('video')
      .description('generate a video (from text, or from a start image)')
      .argument('<prompt...>', 'what should happen')
      .option('--model <id>', 'video model id (default: a current AITOPIA video model, printed on use)')
      .option('--image <file|url>', 'start image (a local file is uploaded first)')
      .option('--duration <seconds>', 'length in seconds')
      .option('--aspect <ratio>', 'aspect ratio, e.g. 16:9, 9:16')
      .option('--name <name>', 'name for the saved asset')
      .option('--set <key=value>', 'any model field (repeatable, value parsed as JSON)', collect)
      .option('--dry-run', `${DRY_RUN_HELP} (a local --image is not uploaded)`),
  ).action(action((g, words, opts) => videoCommand(createContext(g), words as string[], opts as Parameters<typeof videoCommand>[2])));

  addDeliveryOptions(
    program
      .command('audio')
      .description('generate speech, music or sound')
      .argument('<prompt...>', 'the text to speak, or a description of the sound')
      .option('--model <id>', 'model id (default: a current AITOPIA audio model, printed on use)')
      .option('--name <name>', 'name for the saved asset')
      .option('--set <key=value>', 'extra model field, e.g. voice (repeatable, value parsed as JSON)', collect)
      .option('--dry-run', DRY_RUN_HELP),
  ).action(action((g, words, opts) => audioCommand(createContext(g), words as string[], opts as Parameters<typeof audioCommand>[2])));

  program
    .command('upload')
    .description('upload files (or import public URLs) and print their hosted URLs')
    .argument('<file...>', 'local files or https URLs')
    .action(action((g, files) => uploadCommand(createContext(g), files as string[])));

  addDeliveryOptions(
    program
      .command('run')
      .description('call any AITOPIA tool by name')
      .argument('<tool>', 'tool name from `aitopia tools`')
      .option('--json-args <json>', 'tool arguments as a JSON object')
      .option('--args-file <file>', 'read the arguments from a JSON file ("-" for stdin)')
      .option('--set <key=value>', 'one argument (repeatable, value parsed as JSON)', collect)
      .option('--dry-run', `${DRY_RUN_HELP} (only tools that offer a price check)`),
  ).action(action((g, tool, opts) => runCommand(createContext(g), tool as string, opts as Parameters<typeof runCommand>[2])));

  program
    .command('tools')
    .description('list the tools available to your account')
    .option('--q <text>', 'filter by name or description')
    .action(action((g, opts) => toolsCommand(createContext(g), opts as { q?: string })));

  addDeliveryOptions(
    program
      .command('batch')
      .description('make up to 12 images, videos and audio clips in one go, from a JSON file')
      .argument('<file>', 'JSON file: an array of items, or {"items": [...]} ("-" for stdin)')
      .option('--dry-run', `${DRY_RUN_HELP} (per item and in total)`)
      .option('--wait', 'wait until every item finishes and download it (default)')
      .option('--no-wait', 'return after the first answer; finished files are saved, the rest keep running')
      .addHelpText(
        'after',
        `
Each item: {"kind": "image" | "audio" | "video", "prompt": "...", "modelId": "...",
            "input"?: {...model fields}, "assetName"?: "...", "allowAnyModel"?: true}
Local files in URL fields of "input" (image_url, start_image_url, image_urls, ...) are
uploaded first; relative paths are read from the batch file's folder.
Files are saved in -o <dir> as <assetName or prompt>-<item number>.<ext>.
Exit: 0 all finished, 1 some failed (the rest are still saved), 5 some still running.`,
      ),
  ).action(action((g, file, opts) => batchCommand(createContext(g), file as string, opts as Parameters<typeof batchCommand>[2])));

  addDeliveryOptions(
    program
      .command('status')
      .description('check long runs by their run tokens (up to 12)')
      .argument('<runToken...>', 'tokens printed when the runs were started')
      .option('--wait', 'wait until they finish, then download the results'),
  ).action(action((g, tokens, opts) => statusCommand(createContext(g), tokens as string[], opts as Parameters<typeof statusCommand>[2])));

  return program;
}

/** --json status of a failure: unknown (exit 5), partial, dry_run (a price check with refused items), else failed. */
export function jsonStatus(error: CliError): string {
  if (error.exitCode === EXIT.PENDING) return 'unknown';
  if (error.data.status === 'partial' || error.data.status === 'dry_run') return error.data.status;
  return 'failed';
}

function printError(out: Output, error: CliError, verbose: boolean, cause: unknown): void {
  if (out.jsonMode) {
    out.json({
      ...error.data,
      status: jsonStatus(error),
      code: error.code,
      error: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
      exitCode: error.exitCode,
    });
  }
  out.note(`${out.err.red('Error:')} ${error.message}`);
  if (error.hint) out.note(error.hint);
  for (const line of error.notes) out.note(line);
  if (verbose && cause instanceof Error && cause.stack && !(cause instanceof CliError)) out.note(out.err.dim(cause.stack));
}

function exitWith(code: number): void {
  process.exitCode = code;
  // Let stdout drain before exiting (pipes are asynchronous).
  process.stdout.write('', () => process.exit(code));
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const json = argv.includes('--json');
  const verbose = argv.includes('--verbose');
  const out = new Output({ json, verbose });
  installInterruptHandler(out);
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    exitWith(EXIT.OK);
  } catch (error) {
    if (error instanceof CommanderError) {
      const ok = error.code === 'commander.helpDisplayed' || error.code === 'commander.version';
      if (!ok && json) {
        const message = error.message.replace(/^error:\s*/i, '');
        out.json({ status: 'failed', code: 'USAGE', error: message, exitCode: EXIT.USAGE });
      }
      exitWith(ok ? EXIT.OK : EXIT.USAGE);
      return;
    }
    const cliError = toCliError(error, safeServer(argv));
    printError(out, cliError, verbose, error);
    exitWith(cliError.exitCode);
  }
}

function safeServer(argv: string[]): string | undefined {
  const i = argv.indexOf('--server');
  return (i >= 0 ? argv[i + 1] : undefined) ?? process.env.AITOPIA_MCP_URL ?? 'https://mcp.aitopia.ai/mcp';
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) void main();
