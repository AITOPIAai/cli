# Contributing

Thanks for helping improve the AITOPIA CLI.

## Setup

```sh
git clone https://github.com/AITOPIAai/cli.git
cd cli
npm ci
npm run build
node dist/cli.js --help
```

Node.js 20 or newer is required.

## Before you open a pull request

```sh
npm run lint   # type check + eslint
npm test       # unit tests, no network needed
npm run build
```

- Keep changes focused; one topic per pull request.
- Add or update tests for behavior changes.
- User-facing text is English, short and plain.
- Add a line to `CHANGELOG.md` under an "Unreleased" heading.

## Testing against another server

Set `AITOPIA_MCP_URL` (or pass `--server`) to point the CLI at a staging or local
server. Credentials are stored per server, so this does not affect your normal
sign-in. Use `AITOPIA_CONFIG_DIR` to keep a separate credentials file.

## Reporting bugs

Open an issue with the command you ran, the output (with `--verbose`), your OS
and `aitopia --version`. Report security issues as described in `SECURITY.md`.
