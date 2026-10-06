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
import { agentRunCommand, agentShowCommand, agentsCommand, AGENTS_PAGE_SIZE } from './commands/agents.js';
import { audioCommand, EMOTIONS } from './commands/audio.js';
import { batchCommand } from './commands/batch.js';
import { creditsCommand } from './commands/credits.js';
import { editCommand } from './commands/edit.js';
import { imageCommand } from './commands/image.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { modelCommand, modelsCommand, MODEL_TYPES } from './commands/models.js';
import {
  ASPECT_RATIOS,
  MOTION_MODES,
  motionCommand,
  OUTPAINT_MAX_PIXELS,
  outpaintCommand,
  reframeCommand,
  removeBgCommand,
  UPSCALE_RESOLUTIONS,
  upscaleCommand,
  voiceChangeCommand,
} from './commands/named.js';
import {
  PROJECT_MEDIA_TYPES,
  projectsCreateCommand,
  projectsDeleteCommand,
  projectsFolderCommand,
  projectsListCommand,
  projectsMoveCommand,
  projectsRenameCommand,
  projectsShowCommand,
} from './commands/projects.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { toolsCommand } from './commands/tools.js';
import { TRANSCRIBE_FORMATS, transcribeCommand } from './commands/transcribe.js';
import { uploadCommand } from './commands/upload.js';
import { videoCommand } from './commands/video.js';
import { VOICE_CLONE_CREDITS, voicesCreateCommand, voicesDeleteCommand, voicesListCommand } from './commands/voices.js';

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

/** --project / --folder: where the result is saved in AITOPIA (resolved before anything is spent). */
function addScopeOptions(command: Command): Command {
  return command
    .option('--project <name|id>', 'save the result in this project (a name or id from `aitopia projects`; checked before anything is spent)')
    .option('--folder <name|id>', 'save it in this folder of --project');
}

const EXAMPLES = `
Examples:
  $ aitopia login
  $ aitopia image "a red fox in fresh snow, golden hour" --aspect 16:9
  $ aitopia image "minimal logo of a paper boat" -n 3 -o logos/
  $ aitopia video "the fox turns its head and blinks" --image fox.png
  $ aitopia audio "Welcome to AITOPIA." -o welcome.mp3
  $ aitopia edit photo.jpg "remove the background, upscale it, make it 9:16"
  $ aitopia upscale photo.jpg --scale 4
  $ aitopia remove-bg product.jpg
  $ aitopia reframe clip.mp4 --aspect 9:16
  $ aitopia motion me.png dance.mp4 --dry-run
  $ aitopia voice-change take.mp3 --voice Aria
  $ aitopia image "spring sale banner" --project "Spring campaign" --folder Banners
  $ aitopia projects create "Spring campaign"
  $ aitopia voices create "My voice" sample.m4a --consent
  $ aitopia audio "Thanks for watching." --voice "My voice"
  $ aitopia transcribe interview.mp4 -o interview.srt
  $ aitopia agents --q "background"
  $ aitopia agent run background-remover --set photo=product.jpg
  $ aitopia video "slow pan over a harbor" --duration 10 --dry-run
  $ aitopia batch shots.json -o shots/
  $ aitopia status <runToken> <runToken> --wait
  $ aitopia upload photo.jpg clip.mp4
  $ aitopia run probe_media --set assetUrl=https://cdn.aitopia.ai/...
  $ aitopia credits --json

Exit codes: 0 ok, 1 failed, 2 usage error, 3 not signed in, 4 not enough credits,
5 submitted but outcome unknown (check with \`aitopia status <runToken>\`), 6 runs limited
on your account (the server's message says why), 130 interrupted.
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

  program
    .command('agents')
    .description('list store agents: ready-made AITOPIA agents for one task each (id, name, price, what it does)')
    .option('--q <text>', 'search by name, description or category')
    .option('--category <name>', 'only this category, e.g. higgsfield-video')
    .option('--limit <n>', `how many to show (1-100, default ${AGENTS_PAGE_SIZE})`, parseIntegerOption('--limit', 1, 100))
    .option('--offset <n>', 'skip this many (paging)', parseIntegerOption('--offset', 0, 100_000))
    .option('--all', 'show every match at once (no paging)')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia agents
  $ aitopia agents --q "background remover"
  $ aitopia agents --category higgsfield-video --limit 10 --offset 10
  $ aitopia agents --all --json | jq -r '.agents[].id'

CREDITS is the agent's listed price (a range when it depends on the input).
Listing is free. See an agent's fields with \`aitopia agent <id>\`, run it with
\`aitopia agent run <id>\`.`,
    )
    .action(action((g, opts) => agentsCommand(createContext(g), opts as Parameters<typeof agentsCommand>[1])));

  const agent = program
    .command('agent')
    .usage('[show] <agent> | run <agent> [options]')
    .description("show a store agent's price and input fields (`aitopia agent <id|name>`), or run it (`aitopia agent run`)")
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia agent background-remover
  $ aitopia agent "Music Generator Pro 2"
  $ aitopia agent run background-remover --set photo=product.jpg --dry-run
  $ aitopia agent run music-generator --set songIdea="a summer road trip" --set genre=Rock

An agent is named by its id or its name (any case); when several agents share
the name, the command stops (exit 2) and lists their ids. Find agents with
\`aitopia agents --q <words>\`.`,
    );

  agent
    .command('show', { isDefault: true })
    .description("show a store agent's description, price and input fields (required ones marked *)")
    .argument('<agent>', 'agent id or name from `aitopia agents`')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia agent background-remover
  $ aitopia agent show video-upscaler
  $ aitopia agent "music generator pro 2"
  $ aitopia agent video-upscaler --json | jq '.input.required'

File fields (images, videos, audio) are shown as "file (image)": give them a local
file (uploaded first) or an https URL. Free; nothing is run.`,
    )
    .action(action((g, ref) => agentShowCommand(createContext(g), ref as string)));

  const agentRun = addDeliveryOptions(
    agent
      .command('run')
      .description('run a store agent: uploads local files, shows the price, follows the run and saves its files')
      .argument('<agent>', 'agent id or name from `aitopia agents`')
      .option('--set <key=value>', 'one input field (repeatable; fitted to the field type; a local file for a file field is uploaded first)', collect)
      .option('--input <json|@file>', 'all input fields as a JSON object, or @file.json (@- for stdin); --set wins over it')
      .option('--name <name>', 'name for the saved asset')
      .option('--dry-run', `${DRY_RUN_HELP} (local files are checked, not uploaded)`)
      .option('--wait', 'wait until the agent finishes and download its files (default)')
      .option('--no-wait', 'return once the run is started, with its run token (exit 5)'),
  )
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia agent run background-remover --set photo=product.jpg --dry-run
  $ aitopia agent run background-remover --set photo=product.jpg -o cutouts/
  $ aitopia agent run video-upscaler --set video=clip.mp4 --set target_resolution=2160p --no-wait
  $ aitopia agent run smart-data-analyzer --input @analysis.json --project "Q3 report"

See an agent's fields first with \`aitopia agent <id>\`. --set values are read as
JSON when they parse, then fitted to the field type ("5" for a number field is 5).
Unknown fields and missing required ones stop the command (exit 2) before anything
is uploaded or run. A local path given to a file field (shown as "file (image)"
etc. by \`aitopia agent <id>\`) is uploaded first; with --dry-run it is only
checked. Other fields take text: a local file there stops the command (exit 2);
pass its text instead, e.g. --set data="$(cat sales.csv)".
The listed price is printed before the run; --dry-run shows the price and your
balance. Long runs are followed until they finish; files are saved (-o), text
answers are printed. --no-wait prints the run token: check it later with
\`aitopia status <runToken> --wait\`.
Exit: 0 done, 1 failed, 2 usage, 4 not enough credits, 5 still running (--no-wait)
or outcome unknown, 6 runs limited on your account.`,
    );
  addScopeOptions(agentRun).action(action((g, ref, opts) => agentRunCommand(createContext(g), ref as string, opts as Parameters<typeof agentRunCommand>[2])));

  const image = addDeliveryOptions(
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
  );
  addScopeOptions(image).action(action((g, words, opts) => imageCommand(createContext(g), words as string[], opts as Parameters<typeof imageCommand>[2])));

  const video = addDeliveryOptions(
    program
      .command('video')
      .description('generate a video (from text, or from a start image)')
      .argument('<prompt...>', 'what should happen')
      .option('--model <id>', 'video model id (default: AITOPIA picks one that supports what you asked, printed on use)')
      .option('--image <file|url>', 'start image (a local file is uploaded first)')
      .option('--duration <seconds>', 'length in seconds, e.g. 5, 8, 10 (one the model supports)')
      .option('--aspect <ratio>', 'aspect ratio, e.g. 16:9, 9:16, 1:1')
      .option('--resolution <r>', 'resolution, e.g. 720p, 1080p')
      .option('--audio', 'with native sound (models that make it)')
      .option('--no-audio', 'without sound')
      .option('--name <name>', 'name for the saved asset')
      .addOption(new Option('--set <key=value>').argParser(collect).hideHelp())
      .option('--dry-run', `${DRY_RUN_HELP} (a local --image is not uploaded)`)
      .addHelpText(
        'after',
        `
Examples:
  $ aitopia video "waves at sunset, slow pan"
  $ aitopia video "the fox turns its head and blinks" --image fox.png --duration 5
  $ aitopia video "a drone shot over a harbor" --aspect 9:16 --resolution 1080p --audio
  $ aitopia video "slow pan over a harbor" --model <model-id> --dry-run

Without --model AITOPIA picks a video model that supports what you asked (printed
on use). A value the model does not support (a duration, aspect or resolution) is
refused with the allowed values; nothing is spent. Fields other than these flags:
run the model with \`aitopia run run_model\` (see \`aitopia model <id>\`).`,
      ),
  );
  addScopeOptions(video).action(action((g, words, opts) => videoCommand(createContext(g), words as string[], opts as Parameters<typeof videoCommand>[2])));

  const audio = addDeliveryOptions(
    program
      .command('audio')
      .description('generate speech, music or sound (or speak in one of your cloned voices)')
      .argument('<prompt...>', 'the text to speak, or a description of the sound')
      .option('--model <id>', 'model id (default: a current AITOPIA audio model, printed on use)')
      .option('--voice <name|id>', 'speak the text in one of your cloned voices (see `aitopia voices`); uses that voice\'s speech model')
      .addOption(new Option('--emotion <emotion>', 'read the text in this mood (speech models that support it, e.g. your cloned voices)').choices(EMOTIONS))
      .option('--name <name>', 'name for the saved asset')
      .option('--set <key=value>', 'extra model field (repeatable, value parsed as JSON)', collect)
      .option('--dry-run', DRY_RUN_HELP)
      .addHelpText(
        'after',
        `
Examples:
  $ aitopia audio "Welcome to AITOPIA." -o welcome.mp3
  $ aitopia audio "Thanks for watching, see you next week." --voice "My voice"
  $ aitopia audio "We did it, the launch is live!" --voice "My voice" --emotion happy
  $ aitopia audio "rain on a tin roof, distant thunder" --model <sound-model-id>
  $ aitopia audio "Our spring range is here." --voice "My voice" --project "Spring campaign" --dry-run

--voice takes a voice name or id from \`aitopia voices\` (clone one with \`aitopia voices create\`).
A voice that expired at the provider fails with VOICE_EXPIRED: re-create it with
\`aitopia voices create <name> --consent\` (${VOICE_CLONE_CREDITS} credits).
MiniMax speech and cloned voices also understand inline tags like (laughs), (sighs)
and (breath) in the text.`,
      ),
  );
  addScopeOptions(audio).action(action((g, words, opts) => audioCommand(createContext(g), words as string[], opts as Parameters<typeof audioCommand>[2])));

  const edit = addDeliveryOptions(
    program
      .command('edit')
      .description('edit an image, video or audio file in plain words (AITOPIA plans and runs the steps)')
      .argument('<file|url>', 'the file to edit (a local file is uploaded first) or its https URL')
      .argument('<instruction...>', 'what to change, e.g. "remove the background, upscale to 4K"')
      .option('--dry-run', 'show the plan, the price of each step and your balance; nothing runs or is charged (a local file is still uploaded, which is free)')
      .option('--max-credits <n>', 'do not run if the plan costs more than this', parseIntegerOption('--max-credits', 1, 1_000_000))
      .option('--keep-steps', 'also save the file of every step, as <name>-step-N.<ext>')
      .option('--plan <token>', 'run exactly the plan a --dry-run priced (same file and words, within 1 hour)')
      .addHelpText(
        'after',
        `
AITOPIA picks each step from its models, store agents and editing tools, runs them
in order and feeds each result into the next. The plan is shown first, then each step.
The result is saved as <file name>-edited.<ext> (or at -o).
--dry-run prints the plan and a command with --plan that runs exactly that plan at
that price; without --plan the edit is planned again and may come out differently.
If a step fails, the steps before it are kept: the last finished file is saved
(every finished one with --keep-steps) and the command exits 1.
Exit: 0 done (also --dry-run when your balance is short; it says so), 1 failed or
over --max-credits (the plan and total are shown, nothing ran), 5 outcome unknown.`,
      ),
  );
  addScopeOptions(edit).action(action((g, file, words, opts) => editCommand(createContext(g), file as string, words as string[], opts as Parameters<typeof editCommand>[3])));

  const NAMED_DRY_RUN = `${DRY_RUN_HELP} (a local file is still uploaded, which is free: the price is checked on the file)`;
  const NAMED_NOTE = 'AITOPIA picks the model (with a fallback if it is down); the price is shown with --dry-run.';

  const upscale = addDeliveryOptions(
    program
      .command('upscale')
      .description('upscale an image (2x or 4x) or a video (to 1080p or 4K)')
      .argument('<file|url>', 'the image or video (a local file is uploaded first) or its https URL')
      .addOption(new Option('--scale <n>', 'image: 2 (default) or 4').choices(['2', '4']))
      .addOption(new Option('--resolution <r>', 'video: 1080p (default) or 2160p (4K)').choices([...UPSCALE_RESOLUTIONS]))
      .option('--name <name>', 'name for the saved asset')
      .option('--dry-run', NAMED_DRY_RUN)
      .addHelpText(
        'after',
        `
Examples:
  $ aitopia upscale photo.jpg --scale 4
  $ aitopia upscale clip.mp4 --resolution 2160p --dry-run
  $ aitopia upscale https://cdn.aitopia.ai/.../still -o big.png

An image runs upscale_image (Topaz), a video upscale_video (SeedVR2, priced per second).
The type is told by the file name; a URL that does not tell is checked first (free).
${NAMED_NOTE} Saved as <file name>-upscaled.<ext> (or at -o).`,
      ),
  );
  addScopeOptions(upscale).action(action((g, file, opts) => upscaleCommand(createContext(g), file as string, opts as Parameters<typeof upscaleCommand>[2])));

  const removeBg = addDeliveryOptions(
    program
      .command('remove-bg')
      .description('remove the background of an image (transparent PNG cut-out)')
      .argument('<file|url>', 'the image (a local file is uploaded first) or its https URL')
      .option('--name <name>', 'name for the saved asset')
      .option('--dry-run', NAMED_DRY_RUN)
      .addHelpText(
        'after',
        `
Examples:
  $ aitopia remove-bg product.jpg
  $ aitopia remove-bg product.jpg -o cutouts/ --project "Spring campaign"

${NAMED_NOTE} Saved as <file name>-cutout.png (or at -o).`,
      ),
  );
  addScopeOptions(removeBg).action(action((g, file, opts) => removeBgCommand(createContext(g), file as string, opts as Parameters<typeof removeBgCommand>[2])));

  const side = (name: string) => parseIntegerOption(`--${name}`, 0, OUTPAINT_MAX_PIXELS);
  const outpaint = addDeliveryOptions(
    program
      .command('outpaint')
      .description('extend an image beyond its edges: to an aspect ratio, or by pixels per side')
      .argument('<file|url>', 'the image (a local file is uploaded first) or its https URL')
      .addOption(new Option('--aspect <ratio>', 'target frame').choices([...ASPECT_RATIOS]))
      .option('--left <px>', `pixels to add on the left (0-${OUTPAINT_MAX_PIXELS})`, side('left'))
      .option('--right <px>', `pixels to add on the right (0-${OUTPAINT_MAX_PIXELS})`, side('right'))
      .option('--top <px>', `pixels to add on top (0-${OUTPAINT_MAX_PIXELS})`, side('top'))
      .option('--bottom <px>', `pixels to add at the bottom (0-${OUTPAINT_MAX_PIXELS})`, side('bottom'))
      .option('--prompt <text>', 'what the new area should show')
      .option('--name <name>', 'name for the saved asset')
      .option('--dry-run', NAMED_DRY_RUN)
      .addHelpText(
        'after',
        `
Examples:
  $ aitopia outpaint photo.jpg --aspect 16:9
  $ aitopia outpaint photo.jpg --left 300 --right 300 --prompt "more of the beach"

Give --aspect, or pixels per side (not both). ${NAMED_NOTE}
Saved as <file name>-outpainted.<ext> (or at -o).`,
      ),
  );
  addScopeOptions(outpaint).action(action((g, file, opts) => outpaintCommand(createContext(g), file as string, opts as Parameters<typeof outpaintCommand>[2])));

  const reframe = addDeliveryOptions(
    program
      .command('reframe')
      .description('reframe an image or video to another aspect ratio, filling the new area')
      .argument('<file|url>', 'the image or video (a local file is uploaded first) or its https URL')
      .addOption(new Option('--aspect <ratio>', 'target frame (required)').choices([...ASPECT_RATIOS]))
      .option('--prompt <text>', 'what the new area should show')
      .option('--name <name>', 'name for the saved asset')
      .option('--dry-run', NAMED_DRY_RUN)
      .addHelpText(
        'after',
        `
Examples:
  $ aitopia reframe clip.mp4 --aspect 9:16
  $ aitopia reframe banner.png --aspect 1:1 --prompt "soft studio backdrop" --dry-run

Luma Reframe; a video is priced per second. ${NAMED_NOTE}
Saved as <file name>-<ratio>.<ext>, e.g. clip-9x16.mp4 (or at -o).`,
      ),
  );
  addScopeOptions(reframe).action(action((g, file, opts) => reframeCommand(createContext(g), file as string, opts as Parameters<typeof reframeCommand>[2])));

  const motion = addDeliveryOptions(
    program
      .command('motion')
      .description("make the character in an image perform a reference video's motion (or take its person's place)")
      .argument('<characterImage>', 'image of the character (a local file is uploaded first) or its https URL')
      .argument('<referenceVideo>', 'video with the motion (a local file is uploaded first) or its https URL')
      .option('--prompt <text>', 'scene notes (animate mode)')
      .addOption(new Option('--mode <mode>', 'animate: the character performs the motion (default); replace: the character replaces the person in the video').choices([...MOTION_MODES]))
      .option('--name <name>', 'name for the saved asset')
      .option('--dry-run', NAMED_DRY_RUN)
      .addHelpText(
        'after',
        `
Examples:
  $ aitopia motion me.png dance.mp4
  $ aitopia motion mascot.png wave.mp4 --mode replace --dry-run

animate runs Kling 3.0 Motion Control, replace Wan 2.2 Animate Replace; priced per second
of the reference video. Only use people you have the rights to.
Saved as <image name>-motion.mp4 (or at -o).`,
      ),
  );
  addScopeOptions(motion).action(action((g, image, video, opts) => motionCommand(createContext(g), image as string, video as string, opts as Parameters<typeof motionCommand>[3])));

  const voiceChange = addDeliveryOptions(
    program
      .command('voice-change')
      .description('re-voice the speech in an audio or video file with a preset voice, keeping its timing')
      .argument('<file|url>', 'the audio or video (a local file is uploaded first) or its https URL')
      .option('--voice <preset>', 'preset voice, e.g. Rachel (default), Aria, Roger, Sarah (any case)')
      .option('--denoise', 'also clean background noise from the voice')
      .option('--name <name>', 'name for the saved asset')
      .option('--dry-run', NAMED_DRY_RUN)
      .addHelpText(
        'after',
        `
Examples:
  $ aitopia voice-change take.mp3 --voice Aria
  $ aitopia voice-change interview.mp4 --voice Roger --denoise --dry-run

ElevenLabs Voice Changer. A video gets its sound extracted, changed and put back (each
step billed like its own tool). Presets: Rachel, Drew, Clyde, Paul, Aria, Domi, Dave,
Roger, Fin, Sarah, James, Jane, Juniper, Arabella, Hope, Bradford, Reginald, Gaming,
Austin, Kuon, Blondie, Priyanka, Alexandra, Monika, Mark, Grimblewood.
To speak new text in one of your cloned voices, use \`aitopia audio "<text>" --voice <name>\`.
Saved as <file name>-<voice>.<ext> (or at -o).`,
      ),
  );
  addScopeOptions(voiceChange).action(action((g, file, opts) => voiceChangeCommand(createContext(g), file as string, opts as Parameters<typeof voiceChangeCommand>[2])));

  program
    .command('transcribe')
    .description('turn speech in an audio or video file into subtitles (SRT) or text; 1 credit (2 for a video)')
    .argument('<file|url>', 'the audio or video (a local file is uploaded first) or its https URL')
    .addOption(new Option('--format <format>', 'what to save: srt subtitles, txt plain text, or json with the timings (default: from the -o extension, else srt)').choices([...TRANSCRIBE_FORMATS]))
    .option('--language <code>', 'language spoken, e.g. en, tr, de (default, or auto: detected); a language outside Grok\'s 25 runs Whisper')
    .option('--words', 'one subtitle per word (word-by-word captions); with --json, also the word timings')
    .option('--dry-run', `${DRY_RUN_HELP} (a local file is not uploaded)`)
    .option('-o, --output <path>', 'file, directory, or - for stdout (default: <file name>.srt in the current directory)')
    .option('--force', 'overwrite an existing file')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia transcribe interview.mp3                  # saves interview.srt here
  $ aitopia transcribe talk.mp4 -o subs/              # a video: its sound is extracted first
  $ aitopia transcribe memo.m4a --format txt          # prints the plain text
  $ aitopia transcribe podcast.mp3 --language sw -o podcast.json

Speech to text runs xai/grok-speech-to-text (word timings; 25 languages: ar cs da de
en es fa fil fr hi id it ja ko mk ms nl pl pt ro ru sv th tr vi). Another --language
runs openai/whisper (100+ languages, coarser timing); a code with a region (pt-BR)
counts as its language (pt). A run costs what the model lists (1 credit today; the
price is shown before it runs); a video costs 1 credit more to extract its sound
(audio_tools). A URL whose name does not tell audio from video is checked first (free).
Subtitle lines are at most 42 characters, two lines per cue, about 3.5 s per cue, split
at sentence ends and pauses (Japanese, Chinese and Thai are joined without spaces).
-o: a file (its extension picks the format), a directory, or - for stdout. The default
is <file name>.srt (or .json) in the current directory; txt is printed unless -o is given.
Without --force an existing file is kept and -1, -2 ... is added to the new name.
Up to 2 hours per run: a file checked first (a URL whose name does not tell its type)
and found longer is refused before anything is spent (MEDIA_TOO_LONG, exit 1).
The folder is checked before anything is spent; if saving still fails, the transcript
is printed instead (exit 1), so the paid result is never lost.`,
    )
    .action(action((g, file, opts) => transcribeCommand(createContext(g), file as string, opts as Parameters<typeof transcribeCommand>[2])));

  const projects = program
    .command('projects')
    .description('organize your AITOPIA files in projects and folders (lists them without a subcommand)')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia projects
  $ aitopia projects create "Spring campaign" --description "Ads for the spring sale"
  $ aitopia projects show "Spring campaign" --type video
  $ aitopia image "spring sale banner" --project "Spring campaign" --folder Banners

A project or folder is named by its name (any case) or its id. Projects and folders
are free; files stay in your AITOPIA Creations also when a project is deleted.
--project / --folder on image, video, audio, edit, upscale, remove-bg, outpaint, reframe,
motion, voice-change, batch and agent run save new results there.`,
    );

  projects
    .command('list', { isDefault: true })
    .description('list your projects (newest first): name, number of files, id and link')
    .option('--limit <n>', 'how many to show (1-100)', parseIntegerOption('--limit', 1, 100))
    .option('--offset <n>', 'skip this many (paging)', parseIntegerOption('--offset', 0, 100_000))
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia projects
  $ aitopia projects list --limit 10 --offset 10
  $ aitopia projects --json`,
    )
    .action(action((g, opts) => projectsListCommand(createContext(g), opts as Parameters<typeof projectsListCommand>[1])));

  projects
    .command('create')
    .description('make a new project')
    .argument('<name>', 'project name (1-80 characters, unique among your projects)')
    .option('--description <text>', 'what the project is for')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia projects create "Spring campaign"
  $ aitopia projects create "Podcast S2" --description "Episode art and audio"`,
    )
    .action(action((g, name, opts) => projectsCreateCommand(createContext(g), name as string, opts as { description?: string })));

  projects
    .command('show')
    .description("list a project's folders and files")
    .argument('<project>', 'project name or id')
    .option('--folder <name|id>', 'only the files in this folder')
    .addOption(new Option('--type <type>', 'only this kind of file').choices(PROJECT_MEDIA_TYPES))
    .option('--limit <n>', 'how many files to show (1-100, default 30)', parseIntegerOption('--limit', 1, 100))
    .option('--offset <n>', 'skip this many files (paging)', parseIntegerOption('--offset', 0, 100_000))
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia projects show "Spring campaign"
  $ aitopia projects show "Spring campaign" --folder Banners --type image
  $ aitopia projects show "Spring campaign" --json | jq -r '.assets[].assetUrl'`,
    )
    .action(action((g, project, opts) => projectsShowCommand(createContext(g), project as string, opts as Parameters<typeof projectsShowCommand>[2])));

  projects
    .command('folder')
    .description('make a folder in a project')
    .argument('<project>', 'project name or id')
    .argument('<name>', 'folder name (1-80 characters)')
    .option('--parent <name|id>', 'make it inside this folder')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia projects folder "Spring campaign" Banners
  $ aitopia projects folder "Spring campaign" "Close-ups" --parent Banners`,
    )
    .action(action((g, project, name, opts) => projectsFolderCommand(createContext(g), project as string, name as string, opts as { parent?: string })));

  projects
    .command('move')
    .description('move files into a project (or folder), or take them out of their project')
    .argument('<asset...>', 'file URLs (https://cdn.aitopia.ai/...) or file ids, up to 100')
    .option('--to <project>', 'the project to move them to (name or id)')
    .option('--folder <name|id>', 'a folder of --to')
    .option('--out', 'take them out of their project (they stay in your Creations)')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia projects move https://cdn.aitopia.ai/.../fox.png --to "Spring campaign"
  $ aitopia projects move <url> <url> --to "Spring campaign" --folder Banners
  $ aitopia projects move <url> --out

Files not found among your AITOPIA files are listed; the others are still moved (exit 1).`,
    )
    .action(action((g, assets, opts) => projectsMoveCommand(createContext(g), assets as string[], opts as Parameters<typeof projectsMoveCommand>[2])));

  projects
    .command('rename')
    .description('rename a project (or change its description)')
    .argument('<project>', 'project name or id')
    .argument('<newName>', 'the new name')
    .option('--description <text>', 'a new description')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia projects rename "Spring campaign" "Spring 2027"
  $ aitopia projects rename "Podcast S2" "Podcast S2" --description "Season two"`,
    )
    .action(action((g, project, name, opts) => projectsRenameCommand(createContext(g), project as string, name as string, opts as { description?: string })));

  projects
    .command('delete')
    .description('delete a project and its folders; its files stay in your Creations')
    .argument('<project>', 'project name or id')
    .option('-y, --yes', 'do not ask for confirmation (needed when there is no terminal, e.g. in scripts or with --json)')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia projects delete "Old tests"
  $ aitopia projects delete 76616c2c-3d00-4661-954c-0c6db1a93461 --yes

Asks before deleting (answering no exits 1: "Not deleted"; without a terminal, add
--yes). Only the project and its folders go; every file stays in your AITOPIA
Creations, outside any project.`,
    )
    .action(action((g, project, opts) => projectsDeleteCommand(createContext(g), project as string, opts as { yes?: boolean })));

  const voices = program
    .command('voices')
    .description('your cloned voices ("My voices"): list, clone and delete them (lists them without a subcommand)')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia voices
  $ aitopia voices create "My voice" sample.m4a --consent --dry-run
  $ aitopia voices create "My voice" sample.m4a --consent
  $ aitopia audio "Thanks for watching." --voice "My voice"

Clone only your own voice, or a speaker who gave you permission. A clone costs
${VOICE_CLONE_CREDITS} credits (--dry-run shows the price and your balance); listing and deleting are free.`,
    );

  voices
    .command('list', { isDefault: true })
    .description('list your voices: name, state, when made and last used')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia voices
  $ aitopia voices list --json

A voice never used for speech within 7 days is marked "may have expired": the voice
provider may have removed it. Re-create it with \`aitopia voices create <name> --consent\`.`,
    )
    .action(action((g) => voicesListCommand(createContext(g))));

  addDeliveryOptions(
    voices
      .command('create')
      .description(`clone a voice from a recording of it (${VOICE_CLONE_CREDITS} credits); without a sample, finish or re-create one of your voices`)
      .argument('<name>', 'name for the voice (1-60 characters, unique among your voices)')
      .argument('[sample]', 'the recording: an audio file or a video with sound, 10 s to 5 min, one speaker (a local file is uploaded first)')
      .option('--consent', 'required: confirms the recording is your own voice, or the speaker gave you permission to clone it')
      .option('--language <name>', 'language spoken in the sample, e.g. English')
      .option('-y, --yes', 're-create a voice that is ready (and not expired) without asking; it costs again')
      .option('--dry-run', `${DRY_RUN_HELP} (a local sample is still uploaded, which is free)`),
  )
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia voices create "My voice" sample.m4a --consent --dry-run
  $ aitopia voices create "My voice" sample.m4a --consent -o previews/
  $ aitopia voices create "Narrator" https://cdn.aitopia.ai/.../take3.mp3 --consent --language English
  $ aitopia voices create "My voice" --consent        # re-create an expired voice

--consent is required: it confirms the recording is your own voice, or that the
speaker gave you permission to clone it. Never clone anyone else (no celebrities or
public figures), and never use a voice to impersonate or deceive.
Best sample: 30-60 s of one speaker in a quiet room, no music.
The preview clip is saved (or printed with --no-download). Speak one line with the
voice soon: a cloned voice never used for speech is removed by the provider after
about 7 days. Without a sample, <name> must be one of your voices: one still being
created is finished (not charged again); one that may have expired is re-created
from its stored sample (${VOICE_CLONE_CREDITS} credits). Re-creating a voice that is ready asks
first (--yes in scripts; answering no exits 1, nothing charged).`,
    )
    .action(action((g, name, sample, opts) => voicesCreateCommand(createContext(g), name as string, sample as string | undefined, opts as Parameters<typeof voicesCreateCommand>[3])));

  voices
    .command('delete')
    .description('delete one of your voices')
    .argument('<voice>', 'voice name or id')
    .option('-y, --yes', 'do not ask for confirmation (needed when there is no terminal, e.g. in scripts or with --json)')
    .option('--force', 'also delete a voice that is still being created (that clone is lost)')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia voices delete "Old take"
  $ aitopia voices delete 60307754-60d1-430a-b98e-128ae5278ec9 --yes

Asks before deleting (answering no exits 1: "Not deleted"; without a terminal, add --yes).
The voice provider's own copy cannot be deleted from AITOPIA and may remain until it expires.`,
    )
    .action(action((g, voice, opts) => voicesDeleteCommand(createContext(g), voice as string, opts as { yes?: boolean; force?: boolean })));

  const upload = program
    .command('upload')
    .description('upload files (or import public URLs) and print their hosted URLs')
    .argument('<file...>', 'local files or https URLs')
    .addHelpText(
      'after',
      `
Examples:
  $ aitopia upload photo.jpg clip.mp4
  $ aitopia upload https://example.com/logo.png
  $ aitopia upload shot-*.png --project "Spring campaign" --folder Banners

Uploading is free. --project / --folder keep the files in that project (checked
before anything is uploaded).`,
    );
  upload
    .option('--project <name|id>', 'keep the files in this project (a name or id from `aitopia projects`)')
    .option('--folder <name|id>', 'in this folder of --project')
    .action(action((g, files, opts) => uploadCommand(createContext(g), files as string[], opts as { project?: string; folder?: string })));

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

  const batch = addDeliveryOptions(
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
--project / --folder apply to every item.
Exit: 0 all finished, 1 some failed (the rest are still saved), 5 some still running.`,
      ),
  );
  addScopeOptions(batch).action(action((g, file, opts) => batchCommand(createContext(g), file as string, opts as Parameters<typeof batchCommand>[2])));

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

export function printError(out: Output, error: CliError, verbose: boolean, cause: unknown): void {
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
