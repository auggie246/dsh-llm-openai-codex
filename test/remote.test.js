/** Verify the hand-authored Typert host/client manifests stay isomorphic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPERT, TYPERT_REMOTE } from '../lib/remote.js';

test('host and client Typert contributions expose the same eight direct endpoints', () => {
  assert.equal(TYPERT.package, 'dsh-llm-openai-codex');
  assert.equal(TYPERT.face, 'host');
  assert.deepEqual(
    TYPERT.invocations.map((item) => `${item.namespace}/${item.method}`),
    [
      'codexAuth/status',
      'codexAuth/selectStorage',
      'codexAuth/beginBrowserLogin',
      'codexAuth/beginDeviceLogin',
      'codexAuth/cancelLogin',
      'codexAuth/disconnect',
      'codexAuth/modelsStatus',
      'codexAuth/refreshModels',
    ],
  );
  assert.deepEqual(TYPERT_REMOTE.descriptors, TYPERT.invocations);
  for (const invocation of TYPERT.invocations) {
    assert.equal(invocation.invocation.kind, 'direct');
    assert.equal(invocation.result.mode, 'strict');
    assert.equal(typeof invocation.result.schema.parse, 'function');
  }
});

test('the models status codec accepts a secret-free snapshot and rejects everything else', () => {
  const modelsStatus = TYPERT.invocations.find((item) => item.method === 'refreshModels').result.schema;
  assert.deepEqual(
    modelsStatus.parse({ count: 9, source: 'manifest', fetchedAt: 1_700_000_000_000, error: null }),
    { count: 9, source: 'manifest', fetchedAt: 1_700_000_000_000, error: null },
  );
  assert.deepEqual(
    modelsStatus.parse({ count: 0, source: 'catalog', fetchedAt: null, error: null }),
    { count: 0, source: 'catalog', fetchedAt: null, error: null },
  );
  assert.deepEqual(
    modelsStatus.parse({ count: 7, source: 'cache', fetchedAt: 1, error: 'Codex model discovery failed (503)' }),
    { count: 7, source: 'cache', fetchedAt: 1, error: 'Codex model discovery failed (503)' },
  );
  assert.throws(() => modelsStatus.parse({ count: 1, source: 'manifest', fetchedAt: null, error: null, accessToken: 'never expose this' }));
  assert.throws(() => modelsStatus.parse({ count: 1, source: 'account', fetchedAt: null, error: null }));
  assert.throws(() => modelsStatus.parse({ count: 'many', source: 'catalog', fetchedAt: null, error: null }));
});

test('remote codecs reject malformed input but accept a secret-free status', () => {
  const status = TYPERT.invocations.find((item) => item.method === 'status').result.schema;
  assert.deepEqual(status.parse({
    storage: 'dsh',
    source: 'DSH-managed credentials',
    connected: true,
    expiresAt: 123,
    pending: null,
    error: null,
  }), {
    storage: 'dsh',
    source: 'DSH-managed credentials',
    connected: true,
    expiresAt: 123,
    pending: null,
    error: null,
  });
  assert.throws(() => status.parse({ access_token: 'never expose this' }));
  assert.throws(() => status.parse({ storage: 'dsh', source: 'DSH-managed credentials', connected: true, accountId: 'never expose this', expiresAt: 123, pending: null, error: null }));
});

test('pending status carries a browser authorization URL and no other per-kind fields', () => {
  const status = TYPERT.invocations.find((item) => item.method === 'status').result.schema;
  const base = { storage: 'dsh', source: 'DSH-managed credentials', connected: false, expiresAt: null, error: null };
  assert.deepEqual(
    status.parse({ ...base, pending: { kind: 'browser', expiresAt: 5, url: 'https://auth.openai.com/oauth/authorize?state=s' } }).pending,
    { kind: 'browser', expiresAt: 5, url: 'https://auth.openai.com/oauth/authorize?state=s' },
  );
  assert.deepEqual(
    status.parse({ ...base, pending: { kind: 'device', expiresAt: 5, userCode: 'ABCD', verificationUri: 'https://auth.openai.com/codex/device' } }).pending,
    { kind: 'device', expiresAt: 5, userCode: 'ABCD', verificationUri: 'https://auth.openai.com/codex/device' },
  );
  // A browser pending without its URL would strand the card without a reopen
  // link; a device pending must never carry one.
  assert.throws(() => status.parse({ ...base, pending: { kind: 'browser', expiresAt: 5 } }), /pending\.url/);
  assert.throws(() => status.parse({ ...base, pending: { kind: 'device', expiresAt: 5, userCode: 'ABCD', verificationUri: 'u', url: 'https://x' } }));
});

test('the gateway answers model status and re-announces the adapter on manual refresh', async () => {
  const { CodexAuthGateway } = await import('../lib/remote.js');
  const provided = [];
  const ctx = { reflect: { provide(name, value) { provided.push(name); } } };
  const refreshes = [];
  const controller = {
    modelsStatus: async () => ({ count: 9, source: 'manifest', fetchedAt: 1_700_000_000_000, error: null }),
    refreshModels: async () => {
      refreshes.push('refresh');
      return { count: 9, source: 'manifest', fetchedAt: 1_700_000_000_001, error: null, changed: true };
    },
  };
  let announced = 0;
  const gateway = new CodexAuthGateway(ctx, controller, { onModelsChanged: () => { announced += 1; } });
  assert.deepEqual(provided, ['codexAuth'], 'the gateway registers under the codexAuth service key');
  assert.deepEqual(
    await gateway.modelsStatus(),
    { count: 9, source: 'manifest', fetchedAt: 1_700_000_000_000, error: null },
  );
  const status = await gateway.refreshModels();
  assert.equal(status.count, 9);
  assert.equal(refreshes.length, 1);
  assert.equal(announced, 1, 'a manual refresh re-announces so open pickers re-read');
});
