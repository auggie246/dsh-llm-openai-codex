/**
 * Integration tests for the plugin entry (lib/index.js): configuration
 * resolution against the real pi-ai codex catalog, and registration against
 * a stand-in `llm` service — the same calls the harness's own runtime makes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, name, resolveRoute } from '../lib/index.js';
import { codexCliDocument, scratchAuthFile } from './helpers.js';

const HOUR = 3600_000;

/** A mock host context exposing the seam a host row consumes. */
function mockCtx() {
  const registrations = [];
  const logs = { info: [], warn: [] };
  const ctx = {
    llm: {
      registerAdapter(routes, adapter) {
        registrations.push({ routes, adapter });
        return () => {};
      },
    },
    get: () => undefined,
    logger: {
      info: (msg) => logs.info.push(msg),
      warn: (msg) => logs.warn.push(msg),
    },
  };
  return { ctx, registrations, logs };
}

test('resolving the default route adopts the pi-ai openai-codex catalog', () => {
  const { profiles, route, authPath } = resolveRoute({});
  assert.equal(route, 'openai-codex');
  assert.match(authPath, /auth\.json$/);
  const profile = profiles.get(route);
  assert.ok(profile.piProvider.getModels().length > 0, 'catalog serves models');
  assert.equal(profile.piProvider.baseUrl, 'https://chatgpt.com/backend-api');
  assert.ok(profile.piProvider.getModels().some((m) => m.api === 'openai-codex-responses'));
  assert.equal(profile.retryPolicy.mode, 'normal');
});

test('config.models narrows the catalog and names unknown ids', () => {
  const { profiles } = resolveRoute({ models: ['gpt-5.4-mini'] });
  assert.deepEqual(
    profiles.get('openai-codex').piProvider.getModels().map((m) => m.id),
    ['gpt-5.4-mini'],
  );
  assert.throws(() => resolveRoute({ models: ['gpt-9000-imaginary'] }), /gpt-9000-imaginary/);
});

test('apply registers exactly the configured route with the llm service', () => {
  const { ctx, registrations, logs } = mockCtx();
  apply(ctx, { route: 'codex-sub', displayName: 'ChatGPT Subscription' });
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].routes, ['codex-sub']);
  assert.equal(registrations[0].adapter.providerInfo('codex-sub').name, 'ChatGPT Subscription');
  assert.ok(logs.info.some((m) => m.includes('codex-sub')));
});

test('the registered adapter lists codex catalog models', async () => {
  const { ctx, registrations } = mockCtx();
  apply(ctx, {});
  const models = await registrations[0].adapter.listModels('openai-codex');
  assert.ok(models.length > 0);
  assert.ok(models.every((m) => m.provider === 'openai-codex' && typeof m.id === 'string' && typeof m.name === 'string'));
});

test('resolveModel reports catalog capacities and reasoning efforts', async () => {
  const { ctx, registrations } = mockCtx();
  apply(ctx, {});
  const adapter = registrations[0].adapter;
  const catalog = await adapter.listModels('openai-codex');
  const info = await adapter.resolveModel('openai-codex', catalog[0].id);
  assert.equal(info.provider, 'openai-codex');
  assert.ok(info.context.contextWindow > 0);
  assert.ok(Array.isArray(info.reasoning.efforts), 'reasoning models advertise efforts');
});

test('plugin identity matches the composition contract', () => {
  assert.equal(name, 'llm-openai-codex');
  assert.deepEqual(inject, ['llm']);
});

test('a stream resolves the auth file before any network request', async () => {
  const { ctx, registrations } = mockCtx();
  apply(ctx, { authPath: '/nonexistent/auth.json' });
  const adapter = registrations[0].adapter;
  const catalog = await adapter.listModels('openai-codex');
  const chunks = adapter.stream({ provider: 'openai-codex', model: catalog[0].id, messages: [] });
  await assert.rejects(
    async () => {
      for await (const _ of chunks) {
        // never reached
      }
    },
    (error) => error.code === 'MISSING_CREDENTIAL' && /codex login/.test(error.message),
  );
});

test('an unknown model is rejected before credentials resolve', async () => {
  const scratch = await scratchAuthFile(codexCliDocument({ expMs: Date.now() + HOUR, accountId: 'acct-live' }));
  try {
    const { ctx, registrations } = mockCtx();
    apply(ctx, { authPath: scratch.path });
    const chunks = registrations[0].adapter.stream({ provider: 'openai-codex', model: 'gpt-9000-imaginary', messages: [] });
    await assert.rejects(
      async () => {
        for await (const _ of chunks) {
          // never reached
        }
      },
      /has no configured model/,
    );
  } finally {
    await scratch.cleanup();
  }
});
