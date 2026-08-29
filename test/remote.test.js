/** Verify the hand-authored Typert host/client manifests stay isomorphic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPERT, TYPERT_REMOTE } from '../lib/remote.js';

test('host and client Typert contributions expose the same five direct endpoints', () => {
  assert.equal(TYPERT.package, 'dsh-llm-openai-codex');
  assert.equal(TYPERT.face, 'host');
  assert.deepEqual(
    TYPERT.invocations.map((item) => `${item.namespace}/${item.method}`),
    ['codexAuth/status', 'codexAuth/selectStorage', 'codexAuth/beginBrowserLogin', 'codexAuth/beginDeviceLogin', 'codexAuth/disconnect'],
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
