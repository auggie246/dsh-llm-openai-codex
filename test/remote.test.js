/** Verify the hand-authored Typert host/client manifests stay isomorphic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPERT, TYPERT_REMOTE } from '../lib/remote.js';

test('host and client Typert contributions expose the same six direct endpoints', () => {
  assert.equal(TYPERT.package, 'dsh-llm-openai-codex');
  assert.equal(TYPERT.face, 'host');
  assert.deepEqual(
    TYPERT.invocations.map((item) => `${item.namespace}/${item.method}`),
    ['codexAuth/status', 'codexAuth/selectStorage', 'codexAuth/beginBrowserLogin', 'codexAuth/beginDeviceLogin', 'codexAuth/cancelLogin', 'codexAuth/disconnect'],
  );
  assert.deepEqual(TYPERT_REMOTE.descriptors, TYPERT.invocations);
  for (const invocation of TYPERT.invocations) {
    assert.equal(invocation.invocation.kind, 'direct');
    assert.equal(invocation.result.mode, 'strict');
    assert.equal(typeof invocation.result.schema.parse, 'function');
  }
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
