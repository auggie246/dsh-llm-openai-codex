/**
 * Integration tests for the plugin entry (lib/index.js): configuration
 * resolution against the real pi-ai codex catalog, and registration against
 * a stand-in `llm` service — the same calls the harness's own runtime makes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, assertAdapterContract, inject, name, resolveRoute } from '../lib/index.js';
import { codexCliDocument, scratchAuthFile } from './helpers.js';

const HOUR = 3600_000;

/** A mock host context exposing the seam a host row consumes. */
function mockCtx({ attachments } = {}) {
  const registrations = [];
  const logs = { info: [], warn: [] };
  const ctx = {
    llm: {
      registerAdapter(routes, adapter) {
        registrations.push({ routes, adapter });
        return () => {};
      },
    },
    get: (key) => key === 'attachments' ? attachments : undefined,
    settings: {
      register(_namespace, _schema, options) {
        let value = { ...options.base };
        return {
          get: () => value,
          watch: () => () => {},
          update: async (patch) => { value = { ...value, ...patch }; },
        };
      },
    },
    effect: (callback) => callback(),
    logger: {
      info: (msg) => logs.info.push(msg),
      warn: (msg) => logs.warn.push(msg),
    },
  };
  return { ctx, registrations, logs };
}

test('resolving the default route adopts the pi-ai openai-codex catalog', () => {
  const { profiles, route, customAuthPath } = resolveRoute({});
  assert.equal(route, 'openai-codex');
  assert.equal(customAuthPath, undefined);
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

test('the registered adapter satisfies the 0.1.1 prepareCall contract', async () => {
  // dsh-llm 0.1.1 calls registration.adapter.prepareCall() before every turn;
  // the rc.7 PiAiAdapter lacked it, so every ChatGPT model died with
  // "registration.adapter.prepareCall is not a function" at turn start.
  const { ctx, registrations } = mockCtx();
  apply(ctx, {});
  const adapter = registrations[0].adapter;
  assert.equal(typeof adapter.prepareCall, 'function');
  const catalog = await adapter.listModels('openai-codex');
  const prepared = await adapter.prepareCall('openai-codex', catalog[0].id);
  assert.equal(prepared.model.provider, 'openai-codex');
  assert.equal(prepared.model.id, catalog[0].id);
  assert.equal(typeof prepared.stream, 'function');
});

test('prepareCall freezes model resolution and rejects unknown models eagerly', async () => {
  const { ctx, registrations } = mockCtx();
  apply(ctx, {});
  const adapter = registrations[0].adapter;
  // modelInfo throws synchronously inside prepareCall, so wrap it for rejects.
  await assert.rejects(async () => adapter.prepareCall('openai-codex', 'gpt-9000-imaginary'), /has no configured model/);
});

test('the adapter contract guard names a stale adapter at registration', () => {
  // Stands in for the rc.7 PiAiAdapter: it satisfied the pre-0.1.1 seam but
  // had no prepareCall, so the guard must list exactly that gap.
  const staleAdapter = {
    providerInfo() {},
    providerRetryPolicy() {},
    listModels() {},
    resolveModel() {},
    stream: async function* () {},
  };
  assert.throws(
    () => assertAdapterContract(staleAdapter),
    (error) => error.code === 'ADAPTER_CONTRACT_MISMATCH' && /missing prepareCall/.test(error.message) && /version line/.test(error.message),
  );
  const { ctx, registrations } = mockCtx();
  apply(ctx, {});
  assert.doesNotThrow(() => assertAdapterContract(registrations[0].adapter));
});

test('plugin identity matches the composition contract', () => {
  assert.equal(name, 'llm-openai-codex');
  assert.deepEqual(inject, ['llm', 'settings', 'typert']);
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

test('an image request sends a valid attachment policy', async () => {
  const scratch = await scratchAuthFile(codexCliDocument({ expMs: Date.now() + HOUR, accountId: 'acct-live' }));
  const attachments = {
    async readImageRequest(_ref, policy) {
      if (!Number.isSafeInteger(policy.maxPixels) || policy.maxPixels <= 0) {
        throw new Error('Image request maxPixels must be a positive integer.');
      }
      if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0) {
        throw new Error('Image request maxBytes must be a positive integer.');
      }
      throw new Error('IMAGE_POLICY_ACCEPTED');
    },
  };
  try {
    const { ctx, registrations } = mockCtx({ attachments });
    apply(ctx, { authPath: scratch.path });
    const adapter = registrations[0].adapter;
    const models = await adapter.listModels('openai-codex');
    const model = models.find((item) => item.inputModalities?.includes('image'));
    assert.ok(model, 'Codex catalog has an image-capable model');
    const chunks = adapter.stream({
      provider: 'openai-codex',
      model: model.id,
      messages: [{
        id: 'message-1',
        role: 'user',
        source: { kind: 'user' },
        content: [{
          type: 'image',
          attachment: { attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
        }],
      }],
    });
    await assert.rejects(
      async () => {
        for await (const _ of chunks) {
          // Image preparation fails before the provider network call.
        }
      },
      /IMAGE_POLICY_ACCEPTED/,
    );
  } finally {
    await scratch.cleanup();
  }
});
