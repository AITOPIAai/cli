# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Still version 0.1.0; not published yet. The entries below are part of it.

## [0.1.0] - 2026-09-29

### Added

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

[0.1.0]: https://github.com/AITOPIAai/cli/releases/tag/v0.1.0
