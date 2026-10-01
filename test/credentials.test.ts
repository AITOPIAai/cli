import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configDir, credentialsPath } from '../src/config.js';
import { CredentialStore } from '../src/credentials.js';
import { StoredSessionProvider } from '../src/auth.js';

const PROD = 'https://mcp.aitopia.ai/mcp';
const STAGING = 'https://mcp.staging.aitopia.ai/mcp';
const tokens = (access: string) => ({ access_token: access, token_type: 'Bearer', refresh_token: `r-${access}` });

describe('CredentialStore', () => {
  let dir: string;
  let store: CredentialStore;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'aitopia-cred-')), 'config');
    store = new CredentialStore(credentialsPath({ AITOPIA_CONFIG_DIR: dir }));
  });
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('honors AITOPIA_CONFIG_DIR', () => {
    expect(configDir({ AITOPIA_CONFIG_DIR: dir })).toBe(dir);
    expect(store.path).toBe(join(dir, 'credentials.json'));
  });

  it('keeps servers apart', () => {
    store.update(PROD, (e) => ({ ...e, client: { client_id: 'prod-client' }, tokens: tokens('prod') }));
    store.update(STAGING, (e) => ({ ...e, client: { client_id: 'staging-client' }, tokens: tokens('staging') }));
    expect(store.get(PROD)?.tokens?.access_token).toBe('prod');
    expect(store.get(STAGING)?.tokens?.access_token).toBe('staging');
    expect(store.get(PROD)?.serverUrl).toBe(PROD);

    expect(store.remove(STAGING)).toBe(true);
    expect(store.get(STAGING)).toBeUndefined();
    expect(store.get(PROD)?.client?.client_id).toBe('prod-client');
    expect(store.remove(STAGING)).toBe(false);
  });

  it('stores what it is given unchanged (the SDK relies on the issuer field)', () => {
    const client = { client_id: 'c', redirect_uris: ['http://127.0.0.1:5000/callback'], issuer: 'https://mcp.aitopia.ai/' };
    store.update(PROD, (e) => ({ ...e, client }));
    expect(store.get(PROD)?.client).toEqual(client);
  });

  it.skipIf(process.platform === 'win32')('creates the directory 0700 and the file 0600', () => {
    store.update(PROD, (e) => ({ ...e, tokens: tokens('a') }));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    // No temp files are left after the atomic write.
    expect(readdirSync(dir)).toEqual(['credentials.json']);
  });

  it('removes the file when the last server is removed', () => {
    store.update(PROD, (e) => ({ ...e, tokens: tokens('a') }));
    store.remove(PROD);
    expect(() => statSync(store.path)).toThrow();
  });

  it('treats a damaged file as empty', () => {
    store.update(PROD, (e) => ({ ...e, tokens: tokens('a') }));
    writeFileSync(store.path, '{not json');
    expect(store.get(PROD)).toBeUndefined();
    store.update(PROD, (e) => ({ ...e, tokens: tokens('b') }));
    expect(JSON.parse(readFileSync(store.path, 'utf8')).servers[PROD].tokens.access_token).toBe('b');
  });

  it.skipIf(process.platform === 'win32')('refuses a config directory that is a symlink', () => {
    const real = join(dir, '..', 'real');
    mkdirSync(real);
    const link = join(dir, '..', 'link');
    symlinkSync(real, link);
    const linked = new CredentialStore(join(link, 'credentials.json'));
    expect(() => linked.update(PROD, (e) => ({ ...e, tokens: tokens('a') }))).toThrow(/symbolic link/);
    expect(() => linked.get(PROD)).toThrow(/symbolic link/);
  });

  it.skipIf(process.platform === 'win32')('does not chmod a directory it did not create', () => {
    mkdirSync(dir, { mode: 0o755 });
    store.update(PROD, (e) => ({ ...e, tokens: tokens('a') }));
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it('takes over a stale lock and releases its own', () => {
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, 'credentials.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    store.update(PROD, (e) => ({ ...e, tokens: tokens('a') }));
    expect(store.get(PROD)?.tokens?.access_token).toBe('a');
    expect(readdirSync(dir)).toEqual(['credentials.json']);
  });

  it('keeps a refresh token another process stored after this one was rejected', async () => {
    store.update(PROD, (e) => ({ ...e, client: { client_id: 'c' }, tokens: tokens('one') }));
    const provider = new StoredSessionProvider(store, PROD);
    provider.refreshWaitMs = 200;
    expect(provider.tokens()?.refresh_token).toBe('r-one');
    // Another command refreshes meanwhile (the server rotated r-one into r-two).
    store.update(PROD, (e) => ({ ...e, tokens: tokens('two') }));
    await provider.invalidateCredentials('tokens');
    expect(store.get(PROD)?.tokens?.refresh_token).toBe('r-two');
  });

  it('drops the tokens when the rejected refresh token is still the stored one', async () => {
    store.update(PROD, (e) => ({ ...e, client: { client_id: 'c' }, tokens: tokens('one') }));
    const provider = new StoredSessionProvider(store, PROD);
    provider.refreshWaitMs = 50;
    provider.tokens();
    await provider.invalidateCredentials('tokens');
    expect(store.get(PROD)?.tokens).toBeUndefined();
    expect(store.get(PROD)?.client?.client_id).toBe('c');
  });
});
