/** Shared test fixtures: unsigned-but-decodable JWTs and synthetic auth documents. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Build a syntactically valid, unsigned JWT whose payload is `payload`. */
export function fakeJwt(payload) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'none', typ: 'JWT' })}.${segment(payload)}.signature`;
}

/** An access token expiring at `expMs` (epoch ms), claiming `accountId`. */
export function accessToken({ expMs, accountId = 'acct-123' } = {}) {
  return fakeJwt({
    exp: Math.floor(expMs / 1000),
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  });
}

/** A Codex CLI auth document around synthetic tokens. */
export function codexCliDocument({ expMs, accountId = 'acct-123', refresh = 'refresh-v1' } = {}) {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ sub: 'user-1' }),
      access_token: accessToken({ expMs, accountId }),
      refresh_token: refresh,
      account_id: accountId,
    },
    last_refresh: '2025-01-01T00:00:00.000Z',
  };
}

/** A token-endpoint success body carrying a rotated pair. */
export function refreshedPair({ expMs, accountId = 'acct-123', refresh = 'refresh-v2' } = {}) {
  return {
    access_token: accessToken({ expMs, accountId }),
    refresh_token: refresh,
    id_token: fakeJwt({ sub: 'user-1', rotated: true }),
    expires_in: Math.max(1, Math.floor((expMs - Date.now()) / 1000)),
  };
}

/** A minimal fetch stub: records calls, answers 200 with `refreshedPair()` by default. */
export function fetchStub(behavior = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body?.toString() });
    if (behavior.respond) return behavior.respond(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => refreshedPair({ expMs: behavior.expMs ?? Date.now() + 3600_000 }),
      text: async () => '',
    };
  };
  impl.calls = calls;
  return impl;
}

/** A scratch directory owning one auth file, removed by `cleanup()`. */
export async function scratchAuthFile(document) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-test-'));
  const path = join(dir, 'auth.json');
  if (document !== undefined) await writeFile(path, JSON.stringify(document));
  return {
    dir,
    path,
    write: (next) => writeFile(path, JSON.stringify(next)),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
