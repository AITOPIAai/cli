# AITOPIA CLI

Use [AITOPIA](https://aitopia.ai) from your terminal: generate images, video and
audio, analyze videos (summary, timed scenes, ad review, a prompt to re-create
them), run editing tools, check your credits and download the results.

```sh
npm install -g aitopia
aitopia login
aitopia image "a red fox in fresh snow, golden hour"
```

## Install

Requires [Node.js](https://nodejs.org) 20 or newer.

```sh
npm install -g aitopia      # installs the `aitopia` command
aitopia --version
```

Or run it without installing:

```sh
npx aitopia@latest --help
```

## Sign in

```sh
aitopia login
```

Your browser opens the AITOPIA sign-in page. After you sign in, the terminal
says `Signed in`. If you are already signed in to AITOPIA in that browser, this
takes a second.

- On a machine without a browser, use `aitopia login --no-browser` and open the
  printed link on the same machine (the link returns to `127.0.0.1`).
- `aitopia whoami` shows where you are signed in; `aitopia logout` signs out.

Generation spends your AITOPIA credits. Check them with `aitopia credits`.

## Examples

Generate an image and save it in the current directory:

```sh
aitopia image "a red fox in fresh snow, golden hour" --aspect 16:9
# Model: google/nano-banana-2          (example output)
# Saved a-red-fox-in-fresh-snow-golden-hour.png
```

Without `--model`, the CLI picks a current AITOPIA model for the job and prints
which one it used. Files are named after the prompt (or `--name`).

Three variations into a folder:

```sh
aitopia image "minimal logo of a paper boat" -n 3 -o logos/
```

A video from a local image (the image is uploaded first):

```sh
aitopia video "the fox turns its head and blinks" --image fox.png -o fox.mp4
```

Without `--model`, AITOPIA picks a video model that supports what you asked
(printed as `Model: ...`). `--duration`, `--aspect`, `--resolution` and
`--audio` / `--no-audio` (native sound) go to that model; a value it does not
support is refused with the allowed values, and nothing is spent.

Speech or sound:

```sh
aitopia audio "Welcome to AITOPIA. Let's make something." -o welcome.mp3
```

Upload files and get hosted URLs you can pass to any tool:

```sh
aitopia upload photo.jpg clip.mp4
aitopia upload shot-*.png --project "Spring campaign" --folder Banners
```

Pick a model yourself (and, for images and audio, set any of its fields):

```sh
aitopia models --type video              # current models first
aitopia models --type video --all        # include models outside the recommended set
aitopia model <model-id>                 # shows its input fields
aitopia video "waves at sunset" --model <model-id> --duration 5 --resolution 1080p
aitopia image "a paper boat" --model <model-id> --set <field>=<value>
```

`video` takes no `--set`; to set other fields of a video model, run it with
`aitopia run run_model --set modelId=<model-id> --set input='{"prompt":"..."}'`.

Run any AITOPIA tool (see `aitopia tools`):

```sh
aitopia run trim_video --json-args '{"videoAssetUrl":"https://cdn.aitopia.ai/...","segments":[{"startSec":0,"endSec":5}]}'
echo '{"assetUrl":"https://cdn.aitopia.ai/..."}' > args.json
aitopia run probe_media --args-file args.json
```

Use it in a script with `--json`:

```sh
url=$(aitopia image "app icon, flat, blue" --no-download --json | jq -r '.assetUrl')
echo "$url"
```

Check the price first. `--dry-run` works on `image`, `video`, `audio`, `edit`, the one-step edit commands
(`upscale`, `remove-bg`, ...), `transcribe`, `voices create`, `agent run`, `batch` and `run` (for tools that offer a price check). Nothing is submitted or charged:

```sh
aitopia video "slow pan over a harbor at dawn" --duration 10 --dry-run
# Estimate: 100 credits                 (example output)
# Basis: 10 s x 10 credits per second at 720p.
# Balance: 8,951 credits available
# Affordable: yes
# Nothing was submitted or charged.
```

A dry run exits 0 also when your balance does not cover the price; it then says
`Affordable: no, not enough credits` and prints the link to buy credits (with
`--json`, check `affordable`). A model without a listed price fails with
`PRICE_UNKNOWN` (exit 1). `video --dry-run` does not upload a local `--image`.

Edit a file you already have, in plain words. AITOPIA plans the steps (models,
store agents and editing tools), shows the plan and runs it; each step's result
feeds the next:

```sh
aitopia edit fox.jpg "remove the background, upscale to 4K, make it a 9:16 story"
# Plan: Remove the background, upscale to 4K, then pad to 9:16.   (example output)
#   1. Bria Remove Background (model) · 2 credits
#      Cuts the subject out cleanly.
#   2. Topaz Image Upscale (model) · 4 credits
#      Sharpens it to 4K.
#   3. Resize (ffmpeg) · 0 credits
#      Pads it to 9:16 for a story.
# Step 2/3 · Upscaling with Topaz Image Upscale
# Saved fox-edited.png
# Total: 6 credits
# Open in AITOPIA: https://aitopia.ai/...
```

A local file is uploaded first; an https URL is used as is. `--dry-run` shows
the plan with each step's price and your balance (nothing runs), plus a command
with `--plan <token>` that runs exactly that plan, never above that price, once
within an hour (without `--plan` the edit is planned again and can differ). `--max-credits N`
refuses a plan that costs more (`OVER_BUDGET`, exit 1, the plan and total are
shown, nothing ran). `--keep-steps` also saves every intermediate file as
`fox-edited-step-1.png`, `fox-edited-step-2.png`, ... If a step fails, the
chain stops there: the last finished file is saved (all of them with
`--keep-steps`), the error names the failed step and the command exits 1
(4 when it ran out of credits; with `--json` the status is `"partial"`). Finished steps are
paid for and stay in AITOPIA, so do not run them again.

One-step edits have their own commands; AITOPIA picks the model for each (with a
fallback when it is down), so there is nothing to plan:

```sh
aitopia upscale photo.jpg --scale 4                 # image: 2x (default) or 4x
aitopia upscale clip.mp4 --resolution 2160p         # video: 1080p (default) or 4K
aitopia remove-bg product.jpg                       # transparent PNG cut-out
aitopia outpaint beach.png --aspect 16:9            # or --left/--right/--top/--bottom <px>
aitopia reframe clip.mp4 --aspect 9:16 --prompt "city street at night"
aitopia motion me.png dance.mp4                     # --mode replace: swap into the video
aitopia voice-change take.mp3 --voice Aria --denoise
```

They take a local file (uploaded first, also for `--dry-run`, because the price
is checked on the file; uploading is free) or an https URL, and save the result
as `<file name>-upscaled`, `-cutout`, `-outpainted`, `-9x16`, `-motion` or
`-<voice>` (or at `-o`). `upscale` picks the image or video tool from the file
name; a URL that does not tell is checked first with the free `probe_media`.
Videos are priced per second. `voice-change` takes the preset voices listed in
`aitopia voice-change --help`; to speak new text in one of your cloned voices use
`aitopia audio "<text>" --voice <name>`. `motion`: only use people you have the
rights to.

Make several things at once (up to 12, any mix of models and media) from a
JSON file:

```json
[
  { "kind": "image", "prompt": "a red fox in fresh snow", "modelId": "google/nano-banana-2" },
  { "kind": "image", "prompt": "a paper boat on a pond", "modelId": "google/nano-banana-2", "assetName": "Boat" },
  { "kind": "video", "prompt": "the fox turns its head", "modelId": "<video-model-id>",
    "input": { "start_image_url": "./fox.png", "duration": 5 } }
]
```

```sh
aitopia batch shots.json --dry-run      # price per item and in total
aitopia batch shots.json -o shots/
# Saved shots/a-red-fox-in-fresh-snow-1.png
# Saved shots/boat-2.png
# Saved shots/the-fox-turns-its-head-3.mp4
# 3 of 3 items finished.
```

Each item takes `kind` (`image`, `audio` or `video`), `prompt`, `modelId` (from
`aitopia models`), and optionally `input` (the model's own fields),
`assetName` and `allowAnyModel`. The file may also be `{"items": [...]}`, or
`-` for stdin. Local paths in URL fields of `input` (`image_url`,
`start_image_url`, `image_urls`, ...) are uploaded first, each file once;
relative paths are read from the batch file's folder. Finished files are saved
as soon as each item is done, named after `assetName` or the prompt plus the
item number. A failed item does not stop the others: they are still saved,
and the command exits 1 naming what failed (items refused with `SLOT_TIMEOUT`,
`BATCH_UNAVAILABLE` or `MODEL_CHECK_UNAVAILABLE` were not charged and can
simply be run again). `--no-wait` returns after the first answer and exits 5
with the run tokens of the items still going.

Keep your files in projects. `--project` (and `--folder`) on `image`, `video`,
`audio`, `edit`, the one-step edit commands, `batch` and `agent run` saves new results there; a project or folder is named
by its name (any case) or its id, and is checked before anything is spent:

```sh
aitopia projects                                   # name, files, id, link
aitopia projects create "Spring campaign"
aitopia projects folder "Spring campaign" Banners
aitopia image "spring sale banner" --project "Spring campaign" --folder Banners
aitopia projects show "Spring campaign" --type image
aitopia projects move https://cdn.aitopia.ai/.../fox.png --to "Spring campaign"
aitopia projects move https://cdn.aitopia.ai/.../fox.png --out
aitopia projects rename "Spring campaign" "Spring 2027"
aitopia projects delete "Spring 2027"              # asks first; --yes in scripts
```

Projects are free. Deleting a project removes it and its folders only: every
file stays in your AITOPIA Creations. `delete` asks first (answering no exits 1,
"Not deleted"; without a terminal, add `--yes`). `move` reports files it could
not find (exit 1; the others are moved). A name with the exact same case wins;
otherwise the name is matched ignoring case, and when that fits several
projects (say `Dup` and `dup`, asked for as `DUP`) it is ambiguous: use the id.

Clone your own voice once, then speak any text in it:

```sh
aitopia voices create "My voice" me.m4a --consent --dry-run   # price and balance
aitopia voices create "My voice" me.m4a --consent
# Ready: the voice "My voice" (60307754-...)    (example output)
# Saved my-voice-preview.mp3
aitopia audio "Thanks for watching, see you next week." --voice "My voice"
aitopia audio "We did it, the launch is live!" --voice "My voice" --emotion happy
aitopia voices                                  # name, state, created, last used
aitopia voices delete "My voice"
```

`--consent` is required: it confirms the recording is your own voice, or that
the speaker gave you permission to clone it. Never clone anyone else. A clone
costs 150 credits; the sample is an audio file or a video with sound, 10 s to
5 min (best 30-60 s, one speaker, no music), and a local file is uploaded first.
Use a new voice for speech within about 7 days, or the voice provider may remove
it (`aitopia voices` then says "may have expired", and speaking fails with
`VOICE_EXPIRED`): `aitopia voices create "My voice" --consent` without a sample
re-creates it from the stored sample (150 credits again, always shown) or
finishes one that is still being created (not charged again). Re-creating a
voice that is ready and not flagged as expired asks first (`--yes` in scripts).

`--emotion` reads the text in a mood: `happy`, `sad`, `angry`, `fearful`,
`disgusted`, `surprised`, `calm` or `fluent`. Speech models that support it use
it (MiniMax speech, so your cloned voices); with another model the CLI prints the
server's notice that the emotion was not used. MiniMax speech and cloned voices
also understand inline tags like `(laughs)`, `(sighs)` and `(breath)` in the text.

Run a store agent: ready-made AITOPIA agents for one task each (background
removal, upscaling, music, product ads, ...):

```sh
aitopia agents --q "background"                  # id, name, listed price, description
aitopia agent background-remover                 # description, price, input fields
aitopia agent run background-remover --set photo=product.jpg --dry-run
aitopia agent run background-remover --set photo=product.jpg -o cutouts/
aitopia agent run video-upscaler --set video=clip.mp4 --set target_resolution=2160p
```

An agent is named by its id or its name (any case; several agents with the same
name stop with exit 2 and list their ids). `--set field=value` sets one input
field (fitted to its type) and `--input '{...}'` or `--input @file.json` sets
many; unknown fields and missing required ones stop the command (exit 2) before
anything is uploaded or run. A local file given to a file field (shown as
`file (image)` etc.) is uploaded first; `--dry-run` only checks it and shows the
price and your balance. Other fields take text: a local file there stops the
command (exit 2); pass its text, e.g. `--set data="$(cat sales.csv)"`. The listed price is printed before a run,
long runs are followed to the end, files are saved and text answers printed.
`--no-wait` prints the run token instead (exit 5); `--project` / `--folder` save
the result in a project.

### Video analysis: summary, scenes, ad review, re-create prompt

`aitopia analyze` watches a video (or looks at an image, or listens to audio)
and tells you what is in it: what happens, what is said, the text on screen,
the music and sound. It can also list every scene with its time, score an ad,
write a prompt that re-creates the clip, or answer your question about it.

```sh
aitopia analyze clip.mp4                              # summary, speech, on-screen text, audio
aitopia analyze clip.mp4 --mode scenes -o shots.json  # every shot with start/end seconds
aitopia analyze ad.mp4 --mode ad-review               # score, hook, message, CTA, pacing, improvements
aitopia analyze photo.jpg --mode prompt               # a prompt to re-create it
aitopia analyze clip.mp4 "Is the logo visible in the first 3 seconds?"
aitopia analyze clip.mp4 --language tr                # the report in Turkish (any language)
```

Example (`--mode scenes`):

```text
Scenes (4):
  - 0:00-0:01  A colour test pattern with the number 0 on the right.
  - 0:01-0:02  The number changes to 1.
  - 0:02-0:03  The number changes to 2.
  - 0:03-0:04  The number changes to 3.

Audio:
  A steady, high-pitched test tone.
```

Example (`--mode ad-review`):

```text
Ad review (7/10):
  - Hook: Opens on a calm sunset over the ocean.
  - Pacing: slow
  - Strengths: Vibrant, calming colours; smooth camera movement
  - Improve: No clear call to action
  - Improve: No visible brand or logo
```

- **Modes:** `summary` (default), `scenes`, `ad-review`, `prompt`; a question is
  answered first.
- **Output:** a readable report, or `-o report.md` / `.txt` / `.json`; `--json`
  for scripts. JSON fields: `summary`, `answer`, `scenes[]` (`start`, `end`,
  `description`), `spokenText`, `onScreenText[]`, `audio`, `adReview`,
  `recreatePrompt`, `modelId`.
- **Limits:** a video up to **2 MB** for now (and 45 minutes); images and audio
  files too. A bigger video stops before it is uploaded.
- **Price:** about 3 credits per analysis; `--dry-run` shows the price and your
  balance. A failed run is not charged.
- It runs the server's `analyze_media` tool on `google/gemini-3.5-flash`. When the
  provider fails a video, it is tried once on `google/gemini-3-flash`. Nothing is
  saved in AITOPIA.

The same analysis works in [AITOPIA chat](https://aitopia.ai) ("analyze this
video", "score this ad") and in Claude, ChatGPT, Cursor and other MCP clients
through the `analyze_media` tool.

Turn speech into subtitles or text (1 credit; a video costs 1 more because its
sound is extracted first):

```sh
aitopia transcribe interview.mp3                 # saves interview.srt
aitopia transcribe talk.mp4 -o subs/             # subs/talk.srt
aitopia transcribe memo.m4a --format txt         # prints the text
aitopia transcribe podcast.mp3 --language sw -o podcast.json
```

It runs `xai/grok-speech-to-text` with word timings and builds the subtitles
locally: lines of at most 42 characters, two lines and about 3.5 s per cue,
split at sentence ends and pauses (`--words`: one cue per word; Japanese,
Chinese and Thai are joined without spaces). A `--language` outside Grok's 25
runs `openai/whisper` instead (100+ languages, coarser timing; long segments are
split into several cues); `pt-BR` counts as `pt`, and `auto` (like leaving it out)
lets the model detect it. A URL whose name does not tell audio from video is
checked first with the free `probe_media`; one longer than 2 hours (the most one
run takes) is refused there, before anything is spent. The output
path is checked before anything is spent; if saving still fails, the transcript
is printed so it is not lost. The format comes
from `--format` or the `-o` extension (`.srt`, `.txt`, `.json` with the word
timings); `-o -` writes to stdout.

Long runs (most videos) show a progress line with the server's own status and
an estimate of the time left when one is known. Press Ctrl+C to stop waiting:
finished results are listed (saved files, or their URLs if not downloaded yet),
the run keeps going in AITOPIA, and the CLI prints a command to pick it up
again. The same command is printed when the CLI cannot learn the outcome (exit
code 5). `status` takes up to 12 tokens at once:

```sh
aitopia status <runToken> --wait
aitopia status <runToken> <runToken> <runToken> --wait -o results/
```

While waiting, every status check is held open by the server for up to 20
seconds, so the CLI asks rarely and still sees the result as soon as it is
ready. A run that has not finished two hours after it started is reported as
`RUN_STALE` (exit 1) with a link to your AITOPIA creations; a token that is
mistyped, older than 7 days or from another account is reported as not valid.

If a model id is unknown or not one of AITOPIA's recommended models, the error
lists the closest current models (`Did you mean: ...`).

## Commands

| Command | What it does |
|---|---|
| `aitopia login [--no-browser]` | Sign in with your AITOPIA account |
| `aitopia logout` | Sign out and remove the local sign-in |
| `aitopia whoami` | Show the signed-in server and your credits |
| `aitopia credits` | Show your credit balance |
| `aitopia models [--type image\|video\|audio\|text] [--q text] [--limit n] [--offset n] [--all]` | List models (`--all` adds models outside the recommended set) |
| `aitopia model <id>` | Show a model's input fields |
| `aitopia agents [--q text] [--category c] [--limit n] [--offset n] [--all]` | List store agents (id, name, listed price, description) |
| `aitopia agent <id\|name>` | Show a store agent's description, price and input fields |
| `aitopia agent run <id\|name> [--set k=v] [--input json\|@file] [--dry-run] [--no-wait]` | Run a store agent (local files uploaded first, files saved) |
| `aitopia image <prompt> [--model id] [--aspect r] [-n 1-4] [--set k=v] [--dry-run]` | Generate images |
| `aitopia video <prompt> [--model id] [--image file\|url] [--duration s] [--aspect r] [--resolution r] [--audio \| --no-audio] [--dry-run]` | Generate a video (AITOPIA picks the model unless `--model`) |
| `aitopia audio <text> [--model id \| --voice name] [--emotion mood] [--set k=v] [--dry-run]` | Generate speech, music or sound (`--voice`: in one of your cloned voices; `--emotion`: in a mood) |
| `aitopia edit <file\|url> <instruction> [--dry-run] [--plan token] [--max-credits n] [--keep-steps]` | Edit a file in plain words (planned steps, shown first) |
| `aitopia upscale <file\|url> [--scale 2\|4] [--resolution 1080p\|2160p] [--dry-run]` | Upscale an image (2x/4x) or a video (1080p/4K) |
| `aitopia remove-bg <file\|url> [--dry-run]` | Remove an image's background (transparent PNG) |
| `aitopia outpaint <file\|url> (--aspect r \| --left/--right/--top/--bottom px) [--prompt text] [--dry-run]` | Extend an image beyond its edges |
| `aitopia reframe <file\|url> --aspect r [--prompt text] [--dry-run]` | Reframe an image or video to another aspect ratio |
| `aitopia motion <characterImage> <referenceVideo> [--mode animate\|replace] [--prompt text] [--dry-run]` | Make a character perform a video's motion (or replace its person) |
| `aitopia voice-change <file\|url> [--voice preset] [--denoise] [--dry-run]` | Re-voice speech in an audio or video with a preset voice |
| `aitopia batch <file> [--dry-run] [--wait \| --no-wait]` | Make up to 12 images, videos and audio clips from a JSON file |
| `aitopia analyze <file\|url> [question...] [--mode summary\|scenes\|ad-review\|prompt] [--language code] [-o file] [--dry-run]` | Video analysis: summary, timed scenes, ad review, a re-create prompt, or an answer (video up to 2 MB) |
| `aitopia transcribe <file\|url> [--language code] [--format srt\|txt\|json] [--words] [--dry-run]` | Speech to subtitles or text |
| `aitopia projects [list] [--limit n] [--offset n]` | List your projects |
| `aitopia projects create <name> [--description text]` | Make a project |
| `aitopia projects show <project> [--folder f] [--type image\|video\|audio\|file]` | List a project's folders and files |
| `aitopia projects folder <project> <name> [--parent folder]` | Make a folder |
| `aitopia projects move <asset...> (--to project [--folder f] \| --out)` | Move files (URLs or ids) into a project, or out of it |
| `aitopia projects rename <project> <newName>` | Rename a project |
| `aitopia projects delete <project> [--yes]` | Delete a project (its files stay in Creations) |
| `aitopia voices [list]` | List your cloned voices |
| `aitopia voices create <name> [sample] --consent [--language l] [--dry-run]` | Clone a voice (150 credits), or re-create / finish one of yours |
| `aitopia voices delete <voice> [--yes] [--force]` | Delete a voice |
| `aitopia upload <file\|url...> [--project p [--folder f]]` | Upload files, print their URLs (kept in a project with `--project`) |
| `aitopia run <tool> [--json-args '{...}' \| --args-file f] [--set k=v] [--dry-run]` | Call any tool |
| `aitopia tools [--q text]` | List the tools available to you |
| `aitopia status <runToken...> [--wait]` | Check or wait for long runs (up to 12 tokens) |

`image`, `video`, `audio`, `edit`, `upscale`, `remove-bg`, `outpaint`, `reframe`, `motion`,
`voice-change`, `batch` and `agent run` also take `--project <name|id>`
and `--folder <name|id>` (save the result there).

Commands that produce files also take:

- `-o, --output <path>`: a file, or a directory (existing, or ending with `/`). Default: the current directory.
- `--force`: overwrite existing files. Without it, the CLI adds `-1`, `-2`, ... to the name.
- `--no-download`: print the file URLs instead of downloading.

`--set key=value` values are read as JSON when they parse (`5`, `true`, `["a","b"]`),
otherwise as text. Every result that is saved in AITOPIA also prints an
`Open in AITOPIA` link.

Global options: `--json`, `--verbose`, `--server <url>`, `--version`, `--help`.
`--help` and `--version` always print plain text, also together with `--json`.

## JSON output

With `--json`, stdout carries exactly one JSON object and all progress goes to
stderr. For generation commands it is the tool's result plus `files`, the local
paths that were saved:

```json
{
  "status": "completed",
  "assetUrl": "https://cdn.aitopia.ai/...",
  "openInAitopia": "https://aitopia.ai/...",
  "files": ["/home/me/fox.png"]
}
```

On failure the object has `status: "failed"`, `code`, `error` and `exitCode`
(`status: "unknown"` with exit code 5, plus `runToken` when there is one). If
the result was produced but a download failed, it also carries `assetUrls`.
`aitopia upload` with several files lists every upload that worked in
`uploads`, and the failed ones in `failed`.

`--dry-run` prints the server's estimate as is (`status: "estimate"`,
`credits`, `basis`, `breakdown`, `balance.creditsForGeneration`,
`affordable`); `batch --dry-run` prints `status: "dry_run"`, `totalCredits`,
`complete` and `items` (plus `balance` and `affordable` when the balance could
be read). `batch` and `status` with several tokens print a summary:

```json
{
  "status": "partial",
  "total": 3, "completed": 2, "failed": 1, "running": 0,
  "items": [
    { "index": 0, "kind": "image", "modelId": "google/nano-banana-2", "status": "completed",
      "assetUrl": "https://cdn.aitopia.ai/...", "files": ["/home/me/shots/fox-1.png"] },
    { "index": 2, "kind": "video", "status": "failed", "code": "SLOT_TIMEOUT",
      "error": "...", "retryable": true }
  ],
  "files": ["/home/me/shots/fox-1.png", "/home/me/shots/boat-2.png"]
}
```

With exit code 1 or 5 the same object also has `code`, `error` and `exitCode`,
and `runTokens` lists the runs still going.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (also a `--dry-run` whose price your balance does not cover; it says so) |
| 1 | The tool or run failed (or a network error). For `batch` / several `status` tokens: some items failed; the others are still saved |
| 2 | Usage error (bad arguments) |
| 3 | Not signed in, or the session expired: run `aitopia login` |
| 4 | Not enough credits (for `batch`: every failed item failed for lack of credits) |
| 5 | Submitted, but the outcome is not known yet (still running, the answer was lost, or the connection broke after a paid request was sent). Do not run it again: check with `aitopia status <runToken> --wait`, or look in AITOPIA |
| 6 | Runs are limited (suspended) on your account. The server's message is printed as is; it says why and whom to contact. Nothing was run or charged. For `batch`: every failed item failed for this reason |
| 130 | Interrupted (Ctrl+C) |

## Environment variables

| Variable | Purpose |
|---|---|
| `AITOPIA_MCP_URL` | Server URL (default `https://mcp.aitopia.ai/mcp`). Same as `--server`. |
| `AITOPIA_CONFIG_DIR` | Where the sign-in is stored (default `~/.aitopia`, on Windows `%USERPROFILE%\.aitopia`). |
| `NO_COLOR` | Set to any value to turn off colors. Colors are also off when output is not a terminal. |

## What is stored on your computer

One file: `~/.aitopia/credentials.json` (or `$AITOPIA_CONFIG_DIR/credentials.json`).
It holds the OAuth client registration and the access and refresh tokens for each
server you signed in to. On macOS and Linux it is readable only by your user.
Nothing else is stored. The CLI talks only to AITOPIA (the server and its file
storage) and, for `aitopia upload <url>`, asks the server to import that URL.

To remove it:

```sh
aitopia logout                 # revokes the session and deletes the entry
rm -rf ~/.aitopia              # or delete everything by hand
```

## Troubleshooting

**The browser did not open.** Copy the link printed by `aitopia login` into a
browser on the same computer. On a remote machine over SSH, the link returns to
`127.0.0.1` on that machine, so sign in there (for example with a text browser),
or forward the port shown by `aitopia login` (`Waiting for sign-in on port <port>`)
from your computer with `ssh -L <port>:127.0.0.1:<port> host` and open the link locally.

**"Your session has expired" / exit code 3.** Run `aitopia login` again. Sessions
refresh automatically, but a revoked or very old session needs a new sign-in.
An error that names another service's sign-in (not AITOPIA's) exits 1, not 3:
`aitopia login` does not fix it.

**"A download failed".** The result is already made and paid for: the CLI prints
its URL and the "Open in AITOPIA" link. Download it from there instead of
generating it again.

**"Not enough AITOPIA credits" / exit code 4.** The message shows how many credits
the run needs and how many you have, plus a link to buy more. Check your balance
with `aitopia credits`.

**Runs limited on your account / exit code 6.** AITOPIA has limited or suspended
runs on your account. The CLI prints AITOPIA's message exactly as sent (it may span
several lines and says why and whom to contact). When the limit ends at a known
time, it adds `You can try again in N minutes (at HH:MM).`; when a higher plan lifts
the limit, it adds `Upgrading your AITOPIA plan lifts this limit: https://aitopia.ai/pricing`.
The CLI never retries a limited run by itself. `aitopia credits` and `aitopia whoami`
show the same message as a warning while the limit lasts, and `--dry-run` shows
`Not available: <message>` instead of `Affordable` (still exit 0; with `--json`,
check `runLimit`). With `--json` a failure has `code: "RUN_LIMITED"`, `exitCode: 6`
and `runLimit` (the server's `code`, `reason`, `message`, `retryAfterSeconds`,
`upgrade`). A plain `QUEUE_LIMIT_EXCEEDED` (too many runs going at once) still exits 1.

**Behind a corporate proxy.** Node.js does not use `HTTPS_PROXY` by default. With
Node.js 22.21+ or 24.5+, set `NODE_USE_ENV_PROXY=1` together with `HTTPS_PROXY`.
If the proxy inspects TLS, point `NODE_EXTRA_CA_CERTS` at your company's CA file.

**Something else.** Add `--verbose` to see each request (tokens are never shown)
and [open an issue](https://github.com/AITOPIAai/cli/issues).

## License

[MIT](LICENSE)
