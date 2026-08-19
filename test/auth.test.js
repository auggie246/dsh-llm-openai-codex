/** Unit tests for the Codex credential file (lib/auth.js). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, utimes } from 'node:fs/promises';
import { LlmError } from '@deepseek-ai/dsh-llm';
import {
  CodexAuthFile,
  accountIdOf,
  createCodexAuth,
  decodeJwtPayload,
  documentWithRefreshedTokens,
  expandHome,
  parseAuthDocument,
  refreshTokenPair,
} from '../lib/auth.js';
import { accessToken, codexCliDocument, fakeJwt, fetchStub, refreshedPair, scratchAuthFile } from './helpers.js';

const HOUR = 3600_000;

test('decodeJwtPayload decodes a JWT and rejects non-JWTs', () => {
  assert.deepEqual(decodeJwtPayload(fakeJwt({ a: 1 })), { a: 1 });
  assert.equal(decodeJwtPayload('not-a-jwt'), undefined);
});

test('accountIdOf reads the ChatGPT account claim', () => {
  assert.equal(accountIdOf(accessToken({ expMs: Date.now() + HOUR, accountId: 'acct-xyz' })), 'acct-xyz');
  assert.equal(accountIdOf(fakeJwt({ sub: 'nope' })), undefined);
});

test('expandHome expands a leading tilde only', () => {
  assert.equal(expandHome('~/x', '/h'), '/h/x');
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('/abs/x', '/h'), '/abs/x');
});

test('parseAuthDocument reads the Codex CLI shape and derives expiry from the JWT', () => {
  const expMs = Date.now() + HOUR;
  const credential = parseAuthDocument(codexCliDocument({ expMs }), '/x/auth.json');
  assert.equal(credential.shape, 'codex-cli');
  assert.equal(credential.refresh, 'refresh-v1');
  assert.equal(credential.accountId, 'acct-123');
  assert.ok(Math.abs(credential.expiresAt - expMs) < 1000);
});

test('parseAuthDocument reads the pi OAuth-entry shape', () => {
  const expMs = Date.now() + HOUR;
  const doc = { type: 'oauth', access: accessToken({ expMs }), refresh: 'r', expires: expMs };
  const credential = parseAuthDocument(doc, '/x/auth.json');
  assert.equal(credential.shape, 'pi');
  assert.equal(credential.expiresAt, expMs);
});

test('parseAuthDocument names API-key mode instead of serving it as a subscription', () => {
  assert.throws(
    () => parseAuthDocument({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x', tokens: {} }, '/x/auth.json'),
    (error) => error instanceof LlmError && error.code === 'INVALID_CREDENTIAL' && /API-key login/.test(error.message),
  );
});

test('documentWithRefreshedTokens updates the rotated pair and stamps last_refresh', () => {
  const credential = parseAuthDocument(codexCliDocument({ expMs: Date.now() - HOUR }), '/x/auth.json');
  const now = new Date('2026-01-02T03:04:05.000Z');
  const pair = { access: accessToken({ expMs: now.getTime() + HOUR, accountId: 'acct-9' }), refresh: 'refresh-v2', expiresInMs: HOUR, idToken: fakeJwt({ fresh: 1 }), accountId: 'acct-9' };
  const { document, credential: next } = documentWithRefreshedTokens(credential, pair, now);
  assert.equal(document.auth_mode, 'chatgpt');
  assert.equal(document.tokens.refresh_token, 'refresh-v2');
  assert.equal(document.tokens.access_token, pair.access);
  assert.equal(document.tokens.account_id, 'acct-9');
  assert.notEqual(document.tokens.id_token, credential.raw.tokens.id_token);
  assert.equal(document.last_refresh, now.toISOString());
  assert.equal(next.expiresAt, now.getTime() + HOUR);
});

test('refreshTokenPair posts the refresh grant with the Codex client id', async () => {
  const stub = fetchStub();
  const pair = await refreshTokenPair('refresh-v1', stub);
  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0].url, /auth\.openai\.com\/oauth\/token$/);
  assert.match(stub.calls[0].body, /grant_type=refresh_token/);
  assert.match(stub.calls[0].body, /refresh_token=refresh-v1/);
  assert.match(stub.calls[0].body, /client_id=app_EMoamEEZ73f0CkXaXp7hrann/);
  assert.equal(pair.refresh, 'refresh-v2');
});

test('a fresh token needs no network', async () => {
  const scratch = await scratchAuthFile(codexCliDocument({ expMs: Date.now() + HOUR }));
  try {
    const stub = fetchStub();
    const auth = new CodexAuthFile({ path: scratch.path, fetchImpl: stub });
    const token = await auth.getAccessToken();
    assert.equal(stub.calls.length, 0);
    assert.equal(accountIdOf(token), 'acct-123');
  } finally {
    await scratch.cleanup();
  }
});

test('an expired token refreshes once and persists atomically for later calls', async () => {
  const scratch = await scratchAuthFile(codexCliDocument({ expMs: Date.now() - 1000 }));
  try {
    const stub = fetchStub();
    const auth = new CodexAuthFile({ path: scratch.path, fetchImpl: stub });
    const token = await auth.getAccessToken();
    assert.equal(stub.calls.length, 1);
    const written = JSON.parse(await readFile(scratch.path, 'utf8'));
    assert.equal(written.tokens.refresh_token, 'refresh-v2');
    assert.equal(written.tokens.access_token, token);
    assert.equal(written.auth_mode, 'chatgpt');
    assert.match(written.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
    // Second call: the credential now in memory is fresh, no second refresh.
    assert.equal(await auth.getAccessToken(), token);
    assert.equal(stub.calls.length, 1);
    // The file kept owner-only permissions.
    const mode = (await stat(scratch.path)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await scratch.cleanup();
  }
});

test('concurrent expiring callers share one refresh', async () => {
  const scratch = await scratchAuthFile(codexCliDocument({ expMs: Date.now() - 1000 }));
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    const stub = fetchStub({
      respond: async () => {
        await gate;
        return { ok: true, status: 200, json: async () => refreshedPair({ expMs: Date.now() + HOUR }), text: async () => '' };
      },
    });
    const auth = new CodexAuthFile({ path: scratch.path, fetchImpl: stub });
    const pending = [auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()];
    await new Promise((r) => setTimeout(r, 25));
    release();
    const tokens = await Promise.all(pending);
    assert.equal(stub.calls.length, 1);
    assert.ok(tokens.every((t) => t === tokens[0]));
  } finally {
    await scratch.cleanup();
  }
});

test('a rejected refresh reloads the file and retries the newer refresh token', async () => {
  const scratch = await scratchAuthFile(codexCliDocument({ expMs: Date.now() - 1000, refresh: 'stale' }));
  try {
    const stub = fetchStub({
      respond: async (_url, init) => {
        const body = init.body.toString();
        if (body.includes('refresh_token=stale')) {
          // The Codex CLI rotated the pair concurrently: the file now holds a
          // newer refresh token even though ours was just rejected.
          await scratch.write(codexCliDocument({ expMs: Date.now() - 500, refresh: 'rotated' }));
          return { ok: false, status: 401, json: async () => ({}), text: async () => '{"error":"invalid_grant"}' };
        }
        return { ok: true, status: 200, json: async () => refreshedPair({ expMs: Date.now() + HOUR, refresh: 'rotated-2' }), text: async () => '' };
      },
    });
    const auth = new CodexAuthFile({ path: scratch.path, fetchImpl: stub });
    const token = await auth.getAccessToken();
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[1].body.includes('refresh_token=rotated'), true);
    assert.equal(JSON.parse(await readFile(scratch.path, 'utf8')).tokens.refresh_token, 'rotated-2');
    assert.ok(token.length > 0);
  } finally {
    await scratch.cleanup();
  }
});

test('a rejected refresh with no newer on-disk token surfaces the original error', async () => {
  const scratch = await scratchAuthFile(codexCliDocument({ expMs: Date.now() - 1000 }));
  try {
    const stub = fetchStub({
      respond: async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => 'invalid_grant' }),
    });
    const auth = new CodexAuthFile({ path: scratch.path, fetchImpl: stub });
    await assert.rejects(
      () => auth.getAccessToken(),
      (error) => error instanceof LlmError && error.code === 'AUTH_EXPIRED' && /codex login/.test(error.message),
    );
  } finally {
    await scratch.cleanup();
  }
});

test('a missing file fails with sign-in guidance and names no secret', async () => {
  const scratch = await scratchAuthFile(undefined);
  try {
    const auth = new CodexAuthFile({ path: scratch.path, fetchImpl: fetchStub() });
    await assert.rejects(
      () => auth.getAccessToken(),
      (error) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL' && /codex login/.test(error.message),
    );
  } finally {
    await scratch.cleanup();
  }
});

test('a file another process rewrote is re-read before deciding freshness', async () => {
  const scratch = await scratchAuthFile(codexCliDocument({ expMs: Date.now() + HOUR, refresh: 'v1' }));
  try {
    const stub = fetchStub();
    const now = Date.now();
    const auth = new CodexAuthFile({ path: scratch.path, fetchImpl: stub, now: () => now });
    // Prime the cache with the old file.
    await auth.getAccessToken();
    // Another process rotates the pair: same tokens, bumped mtime.
    await scratch.write(codexCliDocument({ expMs: now + HOUR, refresh: 'v2' }));
    const future = new Date(now + 60_000);
    await utimes(scratch.path, future, future);
    await auth.getAccessToken();
    // Re-read happened (mtime changed), credential still fresh: no refresh call.
    assert.equal(stub.calls.length, 0);
    assert.equal(auth.state.credential.refresh, 'v2');
  } finally {
    await scratch.cleanup();
  }
});

test('createCodexAuth expands a tilde path', () => {
  assert.ok(!createCodexAuth({ path: '~/.codex/auth.json' }).path.startsWith('~'));
});
