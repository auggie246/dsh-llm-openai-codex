/** OAuth browser/device controller tests — no real OpenAI request or listener. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BROWSER_REDIRECT_URI,
  CODEX_DEVICE_USER_CODE_URL,
  CodexOAuthController,
  createAuthorizationUrl,
  createPkce,
  exchangeAuthorizationCode,
} from '../lib/oauth.js';
import { CODEX_TOKEN_URL, parseAuthDocument } from '../lib/auth.js';
import { accessToken, scratchAuthFile } from './helpers.js';

const HOUR = 3600_000;

test('PKCE uses base64url random verifier and SHA-256 challenge', () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(verifier, challenge);
});

test('browser authorization URL carries Codex OAuth + PKCE facts', () => {
  const url = new URL(createAuthorizationUrl({ state: 'state-123', challenge: 'challenge-456' }));
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(url.searchParams.get('redirect_uri'), BROWSER_REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-456');
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(url.searchParams.get('originator'), 'dsh');
});

test('authorization-code exchange posts the PKCE verifier and returns safe token facts', async () => {
  const calls = [];
  const exp = Date.now() + HOUR;
  const result = await exchangeAuthorizationCode({
    code: 'authorization-code',
    verifier: 'verifier',
    redirectUri: BROWSER_REDIRECT_URI,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: accessToken({ expMs: exp, accountId: 'acct-oauth' }), refresh_token: 'rotated-refresh', id_token: 'id-token', expires_in: 3600 }),
      };
    },
  });
  assert.equal(calls[0].url, CODEX_TOKEN_URL);
  assert.match(calls[0].init.body.toString(), /code=authorization-code/);
  assert.match(calls[0].init.body.toString(), /code_verifier=verifier/);
  assert.equal(result.refresh, 'rotated-refresh');
  assert.equal(result.accountId, 'acct-oauth');
  assert.ok(result.expiresAt > Date.now());
});

test('DSH-managed source starts disconnected, stores an interactive login, then disconnects', async () => {
  const scratch = await scratchAuthFile(undefined);
  let selection = 'dsh';
  const controller = new CodexOAuthController({
    storage: () => selection,
    setStorage: async (next) => { selection = next; },
    refreshMarginMs: 60_000,
    dshAuthPath: scratch.path,
    codexAuthPath: '/unused/codex/auth.json',
    fetchImpl: async (url) => {
      assert.equal(url, CODEX_TOKEN_URL);
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: accessToken({ expMs: Date.now() + HOUR, accountId: 'acct-dsh' }), refresh_token: 'new-refresh', id_token: 'new-id', expires_in: 3600 }),
      };
    },
  });
  try {
    const initial = await controller.status();
    assert.equal(initial.storage, 'dsh');
    assert.equal(initial.connected, false);
    await controller.finishAuthorizationCode('code', 'verifier', BROWSER_REDIRECT_URI);
    const connected = await controller.status();
    assert.equal(connected.connected, true);
    assert.equal(connected.accountId, 'acct-dsh');
    const document = JSON.parse(await readFile(scratch.path, 'utf8'));
    assert.equal(parseAuthDocument(document, scratch.path).refresh, 'new-refresh');
    const disconnected = await controller.disconnect();
    assert.equal(disconnected.connected, false);
  } finally {
    await controller.dispose();
    await scratch.cleanup();
  }
});

test('storage selection is host-persisted and shared Codex CLI credentials cannot be deleted by DSH', async () => {
  const scratch = await scratchAuthFile(undefined);
  let selection = 'dsh';
  const controller = new CodexOAuthController({
    storage: () => selection,
    setStorage: async (next) => { selection = next; },
    refreshMarginMs: 60_000,
    dshAuthPath: scratch.path,
    codexAuthPath: '/unused/codex/auth.json',
  });
  try {
    const selected = await controller.selectStorage('codex');
    assert.equal(selected.storage, 'codex');
    await assert.rejects(() => controller.disconnect(), /owned by the Codex CLI/);
  } finally {
    await controller.dispose();
    await scratch.cleanup();
  }
});

test('device code begins with OpenAI device endpoint and exposes code without any tokens', async () => {
  const scratch = await scratchAuthFile(undefined);
  const calls = [];
  const controller = new CodexOAuthController({
    storage: () => 'dsh',
    setStorage: async () => {},
    refreshMarginMs: 60_000,
    dshAuthPath: scratch.path,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === CODEX_DEVICE_USER_CODE_URL) {
        return { ok: true, status: 200, json: async () => ({ device_auth_id: 'device-id', user_code: 'ABCD-EFGH', interval: 60 }) };
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  try {
    const device = await controller.beginDeviceLogin();
    assert.equal(device.kind, 'device');
    assert.equal(device.userCode, 'ABCD-EFGH');
    assert.match(device.verificationUri, /auth\.openai\.com\/codex\/device/);
    assert.equal(calls[0].url, CODEX_DEVICE_USER_CODE_URL);
    // Dispose aborts the unobserved polling loop immediately.
  } finally {
    await controller.dispose();
    await scratch.cleanup();
  }
});
