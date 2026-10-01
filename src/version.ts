import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION: string = pkg.version;

export function userAgent(): string {
  return `aitopia-cli/${VERSION} (node ${process.versions.node}; ${process.platform})`;
}
