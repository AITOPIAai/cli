# Security policy

## Reporting a vulnerability

Please report security issues privately by email to **security@aitopia.ai**.
Do not open a public GitHub issue for security problems.

Include what you found, the steps to reproduce it, and the version of the CLI
(`aitopia --version`). We will confirm receipt and keep you updated on the fix.

## Supported versions

Only the latest published version receives security fixes.

## How the CLI handles your credentials

- Sign-in uses OAuth 2.1 with PKCE and a one-time local redirect on `127.0.0.1`.
- Tokens are stored in `~/.aitopia/credentials.json` (or `$AITOPIA_CONFIG_DIR`),
  readable only by your user (file mode 0600, directory 0700 on macOS and Linux).
- Tokens are never printed, including with `--verbose`.
- `aitopia logout` revokes the session on the server and deletes the local file entry.
