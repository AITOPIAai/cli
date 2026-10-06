# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-06

### Added

- One-step edit commands on the named MCP tools (AITOPIA picks the model, with a fallback): `aitopia upscale <file|url>` (`upscale_image` with `--scale 2|4` for an image, `upscale_video` with `--resolution 1080p|2160p` for a video; the type comes from the file name, else a free `probe_media`), `aitopia remove-bg` (`remove_background`), `aitopia outpaint` (`outpaint_image`, `--aspect` or `--left/--right/--top/--bottom` pixels, `--prompt`), `aitopia reframe --aspect <ratio>` (`reframe`, image or video, `--prompt`), `aitopia motion <characterImage> <referenceVideo>` (`motion_control`, `--mode animate|replace`, `--prompt`) and `aitopia voice-change` (`voice_change`, `--voice <preset>` in any case, `--denoise`). Each uploads a local file first (also for `--dry-run`: the price is checked on the file), takes `--name`, `--dry-run` (the steps of a multi-step run, the total and your balance), `-o`, `--force`, `--no-download`, `--project`, `--folder` and `--json`, follows a run token with live progress and saves the result as `<file name>-upscaled`, `-cutout`, `-outpainted`, `-<ratio>`, `-motion` or `-<voice>`. A file type a command does not take, a missing `--aspect`, or conflicting flags are usage errors (exit 2) before anything is called; a run that stops part way exits 1 and names the last finished file.
- `aitopia upload --project <name|id> [--folder <name|id>]`: the names are resolved like on `image` and `video` (a missing project or folder stops before anything is uploaded) and sent as `projectId` / `folderId` to `upload_asset` and `create_upload_link` (local files and URL imports), so the files are kept in that project.
- `aitopia video --resolution <r>` (e.g. `720p`, `1080p`) and `--audio` / `--no-audio` (native sound, on models that make it).

### Changed

- `aitopia video` calls the `generate_video` tool: without `--model` AITOPIA picks a video model that supports what you asked (your preferred one, then the ones it runs most successfully) and the CLI prints it as `Model: ...`; `--model` is sent as `modelId` (with `allowAnyModel`). `--image`, `--duration` (a positive number of seconds), `--aspect`, `--name`, `--dry-run`, `-o`, `--project` and `--folder` work as before; a value the model does not support is refused by the server with the allowed values (exit 1, nothing spent). `--set` is no longer accepted for `video` (exit 2, with a hint to use `aitopia run run_model`).

### Removed

- `list_connections` from the help examples and the README (integrations are not offered), and the hint that pointed a third-party sign-in failure at it: such a failure still exits 1 (not 3) and keeps the server's own hint.

### Fixed

- `aitopia transcribe --language auto` no longer sends `auto` to Grok Speech-to-Text (its language list has no `auto`): like no `--language`, the language is detected, matching the server.
- `aitopia transcribe` refuses media longer than 2 hours (the server's limit per run) before anything is uploaded, extracted or charged, when the free probe of a URL whose name does not tell its type reports the length (`MEDIA_TOO_LONG`, exit 1, with a hint to split it); a length not known locally is left to the models.

## [0.2.1] - 2026-10-05

### Added

- Run limits (account suspension): a failure with code `RUN_LIMITED`, `QUEUE_LIMIT_EXCEEDED` with reason `abuse_limit`, or a `runLimit` object (top level, under `details` or `balance`) prints the server's message verbatim, line breaks kept, and exits with the new code 6. `retryAfterSeconds` adds `You can try again in N minutes (at HH:MM).`; `upgrade: true` adds `Upgrading your AITOPIA plan lifts this limit: https://aitopia.ai/pricing`; `upgrade: false` adds nothing (the message says whom to contact). A run limit is never retried or polled again, whatever its code, `retryable` or `retryAfterSeconds`. `--json` failures have `code: "RUN_LIMITED"`, `exitCode: 6` and the normalized `runLimit`. A `batch` whose failed items all hit the limit exits 6; an `edit` step stopped by it exits 6 with the finished steps kept.
- `aitopia credits` and `aitopia whoami` print a run limit carried by the balance as a warning with the server's message; `--dry-run` (`image`, `video`, `audio`, `edit`, `transcribe`, `voices create`, `agent run`, `batch`, `run`) prints `Not available: <message>` instead of `Affordable` (still exit 0), and `edit --dry-run` then leaves out the `--plan` command.
- A plain `QUEUE_LIMIT_EXCEEDED` (too many runs going at once, no run-limit reason) keeps its hint and exit 1.

## [0.2.0] - 2026-10-02

### Added

- `aitopia agents`: list the store agents (id, name, listed price in credits, description) with `--q`, `--category`, `--limit`, `--offset` and `--all`.
- `aitopia agent <id|name>` (also `agent show`): an agent's description, category, price, typical duration and input fields (required ones marked `*`, types, file fields as `file (image)`, allowed values, defaults). An agent is named by its exact id, else its name in any case; several agents with that name stop with exit 2 and list their ids; an unknown one exits 1 (`AGENT_NOT_FOUND`) with close matches.
- `aitopia agent run <id|name>`: runs `run_store_agent`. `--set field=value` (fitted to the field type) and `--input <json|@file>`; unknown and missing required fields are usage errors (exit 2) before anything is uploaded or run. Local files given to file fields (x-uap upload widgets, or a URL field described as media) are uploaded first; a local file given to any other field is a usage error (exit 2) that says to pass its text (`--set data="$(cat sales.csv)"`); `--dry-run` checks them without uploading and shows the price and your balance. The listed price is printed before a run, long runs are followed with their run token, files are saved (`-o`, `--force`, `--no-download`), text answers printed, with the Open in AITOPIA link. `--no-wait` (exit 5 with the run token), `--name`, `--project` and `--folder`.
- CLI hints for `AGENT_NOT_FOUND`, a store agent's `NOT_FOUND` and `INVALID_INPUT` (pointing to `aitopia agents` / `aitopia agent <id>`), `UPSTREAM_RUN_FAILED`, `QUEUE_LIMIT_EXCEEDED` and `INPUT_TOO_LARGE`.
- `aitopia audio --emotion <emotion>`: read the text in a mood (`happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`, `calm`, `fluent`), sent to `generate_audio` as `emotion`. Speech models that support it use it (MiniMax speech, so your cloned voices); when the model does not, the server's note says so and it is printed. Works with and without `--voice`, and with `--dry-run`, `--project` and `--json`. Any other value is a usage error (exit 2) before anything is called.

## [0.1.0] - 2026-10-02

First public release.

### Added

- `aitopia projects`: list (`--limit`, `--offset`), `create`, `show` (folders and files, `--folder`, `--type`), `folder` (`--parent`), `move` (file URLs or ids, `--to` a project and folder, or `--out`; files not found are listed, exit 1), `rename` and `delete` (asks first on a terminal, `--yes` otherwise; files stay in Creations). Projects and folders are named by id or name: an exact-case name wins, otherwise the name is matched ignoring case, and several such matches are ambiguous (exit 2, the ids are listed). Answering no to a delete exits 1 ("Not deleted").
- `--project <name|id>` and `--folder <name|id>` on `image`, `video`, `audio`, `edit` and `batch`: resolved once before the paid call, so a project or folder that does not exist stops the command before anything is spent.
- `aitopia voices`: list (state, created, last used, "may have expired"), `create <name> <sample> --consent` (a local sample is uploaded first; `--consent` is required and confirms the voice is your own or the speaker agreed; 150 credits, `--dry-run` for price and balance; a clone still running is followed to the end without a second charge; the preview is saved), `create <name> --consent` without a sample to finish a voice still being created (free) or re-create one from its stored sample (150 credits, always shown; a voice that is ready and not flagged as expired asks first, `--yes` in scripts), and `delete` (`--yes`, `--force` for a voice still being created).
- `aitopia audio --voice <name|id>`: speak in one of your cloned voices.
- `aitopia transcribe <file|url>`: speech to SRT subtitles, plain text or JSON with word timings (`--format`, or from the `-o` extension; `-o -` for stdout). Runs `xai/grok-speech-to-text` and builds cues locally (2 lines x 42 characters, 3.5 s, split at sentence ends and pauses; `--words` for one cue per word); `--language` outside Grok's 25 languages runs `openai/whisper` (long segments split into several cues by time; `pt-BR` counts as `pt`). Japanese, Chinese and Thai are joined without spaces. A video's sound is extracted first (`audio_tools`); a URL whose type its name does not tell is checked with the free `probe_media` first. The output path is checked before anything is spent, and a failed save prints the transcript instead. The price is shown before it runs (1 credit per run today, 2 for a video); `--dry-run` prices it without uploading.
- CLI hints for `VOICE_EXPIRED` (re-create with `aitopia voices create`, 150 credits), `VOICE_BEING_CREATED`, `VOICE_PENDING`, `VOICE_STILL_CLONING`, `VOICE_NAME_TAKEN`, `VOICE_NOT_FOUND`, `SAMPLE_NOT_OWNED`, `USE_CREATE_VOICE`, `VOICES_UNAVAILABLE`, `PROJECT_NOT_FOUND`, `FOLDER_NOT_FOUND`, `PROJECTS_UNAVAILABLE`, `NAME_CONFLICT` and `MODEL_DISABLED`.
- `aitopia edit <file|url> "<instruction>"`: edit an image, video or audio file in plain words. AITOPIA plans the steps (models, store agents, editing tools); the CLI shows the numbered plan with each step's kind, reason and credits, prints each step as it starts, and saves the result as `<name>-edited.<ext>` (or at `-o`). Local files are uploaded first.
- `edit --dry-run` (plan, price per step, total, balance; says so when your credits fall short, exit 0), `--max-credits N` (`OVER_BUDGET`: plan and total shown, nothing ran, exit 1) and `--keep-steps` (intermediate files as `<name>-step-N.<ext>`).
- `edit --plan <token>`: the `--dry-run` prints a ready command that runs exactly the priced plan on the file it uploaded (no second upload), once within an hour; it refuses another file, other words or a changed file, and the server refuses a higher price (`PRICE_CHANGED`) or an expired token (`PLAN_EXPIRED`), nothing run. A dry run still planning after the server's inline wait is followed to its estimate.
- When a step fails mid-chain, the finished work is kept: the last finished file is saved (every one with `--keep-steps`), the error names the failed step, exit 1 (4 when out of credits; `--json` status `"partial"`). `PLAN_UNAVAILABLE`, `PLAN_INVALID`, `NOT_SUPPORTED` and `SERVER_RESTARTING` say nothing ran. `POLL_FAILED` (a step could not be checked; it may still finish) exits 5. `PRICE_UNKNOWN` shows the plan, nothing ran. Steps priced from a listed price show `~N credits (listed price)`, steps that were not needed show `no change needed, 0 credits`, and a file already in the requested form is said so.

- `aitopia login` / `logout`: sign in with your AITOPIA account in the browser (OAuth 2.1 with PKCE and a loopback redirect); sessions refresh automatically.
- `aitopia whoami` and `aitopia credits`: show the signed-in server and credit balance.
- `aitopia models` and `aitopia model <id>`: list models and show a model's input fields.
- `aitopia image`, `aitopia video`, `aitopia audio`: generate media and download the results.
- `aitopia upload`: upload local files or import public URLs.
- `aitopia run <tool>`: call any AITOPIA tool with JSON arguments.
- `aitopia tools`: list the tools available to your account.
- `aitopia status <runToken>`: check or wait for a long run.
- `aitopia batch <file>`: up to 12 images, videos and audio clips (any mix of models) from a JSON file, with local files uploaded first, every finished file saved as soon as it is ready, `--dry-run` per item and in total, and `--no-wait`.
- `--dry-run` on `image`, `video`, `audio`, `batch` and `run`: shows the price, its basis, your balance and whether it is affordable; nothing is submitted or charged.
- `aitopia status` takes up to 12 run tokens at once.
- Live progress: the spinner shows the server's own progress message and the time left when it is known (`--verbose` logs each message to stderr).
- Waiting long-polls on the server (each status check is held up to 20 s), so results show up as soon as they are ready with fewer requests.
- Clear messages for an unknown or not-recommended model (with `Did you mean: ...`), a stale run (`RUN_STALE`, with the creations link), an invalid run token, a model without a price (`PRICE_UNKNOWN`) and batch items that were not started (`SLOT_TIMEOUT`, `BATCH_UNAVAILABLE`; nothing charged).
- `--json` output for scripts, stable exit codes (including 5 for "submitted, outcome unknown"), `NO_COLOR` support.

[0.2.0]: https://github.com/AITOPIAai/cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/AITOPIAai/cli/releases/tag/v0.1.0
