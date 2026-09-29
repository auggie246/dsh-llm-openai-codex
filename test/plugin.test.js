/**
 * Integration tests for the plugin entry (lib/index.js): configuration
 * resolution against the real pi-ai codex catalog, and registration against
 * a stand-in `llm` service — the same calls the harness's own runtime makes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { Config, apply, assertAdapterContract, inject, name, resolveRoute } from '../lib/index.js';
import { codexCliDocument, scratchAuthFile } from './helpers.js';

const HOUR = 3600_000;

// Two distinct ids from the live catalog; tests never hardcode a slug a
// pi-ai upgrade can retire (the generated catalog churns on its own schedule).
const catalogModels = builtinProviders().find((provider) => provider.id === 'openai-codex').getModels();
const KNOWN = catalogModels[0].id;
const ALSO_KNOWN = catalogModels[1].id;

/** A mock host context exposing the seam a host row consumes. */
function mockCtx({ attachments, typert = false } = {}) {
  const registrations = [];
  const logs = { info: [], warn: [] };
  const settingsWrites = [];
  const services = {};
  let adapterUpdates = 0;
  const ctx = {
    // The profile entry this row mounts as: its id is the settings namespace
    // the credential-source write is addressed to.
    fiber: { entry: { options: { id: 'llm-openai-codex' } } },
    llm: {
      registerAdapter(routes, adapter) {
        registrations.push({ routes, adapter });
        return () => {};
      },
      emitAdaptersUpdated() {
        adapterUpdates += 1;
      },
    },
    get: (key) => key === 'attachments' ? attachments : undefined,
    // Harness 0.1.7's SettingsForms: the entry's Config is its settings
    // section, so the only write seam is update(ns, patch).
    settings: {
      configure: () => () => {},
      update: async (ns, patch) => {
        settingsWrites.push({ ns, patch });
      },
    },
    reflect: { provide(key, value) { services[key] = value; } },
    effect: (callback) => callback(),
    logger: {
      info: (msg) => logs.info.push(msg),
      warn: (msg) => logs.warn.push(msg),
    },
  };
  if (typert) ctx.typert = {};
  return { ctx, registrations, logs, services, settingsWrites, adapterUpdates: () => adapterUpdates };
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

test('the default retry policy retries transient provider errors, including the PI_AI_ERROR catch-all', () => {
  // pi-ai raises the codex backend's empty-body error responses as the
  // unclassified "PI_AI_ERROR" (no status text over HTTP/2), and its own
  // request retries are pinned to zero — without this policy one transient
  // response killed the whole turn.
  const { profiles } = resolveRoute({});
  const policy = profiles.get('openai-codex').retryPolicy;
  assert.equal(policy.mode, 'normal');
  assert.equal(policy.maxRetries, 2);
  for (const code of ['PI_AI_ERROR', 'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.ok(policy.retryableCodes.includes(code), `retries ${code}`);
  }
  for (const code of ['AUTH', 'INVALID_REQUEST']) {
    assert.equal(policy.retryableCodes.includes(code), false, `${code} stays non-retryable`);
  }
});

test('an explicit retryPolicy replaces the route default verbatim', () => {
  const { profiles } = resolveRoute({ retryPolicy: { mode: 'normal', maxRetries: 0 } });
  const policy = profiles.get('openai-codex').retryPolicy;
  assert.equal(policy.maxRetries, 0);
  assert.deepEqual([...policy.retryableCodes], ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']);
  assert.throws(() => resolveRoute({ retryPolicy: { mode: 'sometimes' } }), /mode must be/);
});

test('config.models narrows the catalog and reports unknown ids instead of refusing the route', () => {
  // Discovery can make an id valid before the installed catalog knows it, so
  // an unknown filter id is a warning with a served remainder, never a throw.
  const { profiles, unknownModelIds } = resolveRoute({ models: [KNOWN, 'gpt-9000-imaginary'] });
  assert.deepEqual(
    profiles.get('openai-codex').piProvider.getModels().map((m) => m.id),
    [KNOWN],
  );
  assert.deepEqual(unknownModelIds, ['gpt-9000-imaginary']);
  // Catalog order is the served order now; the filter selects, not reorders.
  assert.deepEqual(resolveRoute({ models: [KNOWN] }).profiles.get('openai-codex').piProvider.getModels().map((m) => m.id), [KNOWN]);
});

test('modelOverrides reshape resolved catalog models without touching their siblings', () => {
  const { profiles } = resolveRoute({
    modelOverrides: {
      [KNOWN]: { name: 'Mini (tuned)', contextWindow: 100_000, maxTokens: 16_000, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: false } },
    },
  });
  const model = profiles.get('openai-codex').piProvider.getModels().find((m) => m.id === KNOWN);
  assert.equal(model.name, 'Mini (tuned)');
  assert.equal(model.contextWindow, 100_000);
  assert.equal(model.maxTokens, 16_000);
  assert.equal(model.thinkingLevelMap.xhigh, null, 'a false effort pins the level unsupported');
  const untouched = profiles.get('openai-codex').piProvider.getModels().find((m) => m.id === ALSO_KNOWN);
  assert.equal(untouched.contextWindow, catalogModels.find((m) => m.id === ALSO_KNOWN).contextWindow, 'siblings keep the catalog values');
});

test('apply registers exactly the configured route with the llm service', () => {
  const { ctx, registrations, logs } = mockCtx();
  apply(ctx, { route: 'codex-sub', displayName: 'ChatGPT Subscription', modelDiscovery: 'off' });
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].routes, ['codex-sub']);
  assert.equal(registrations[0].adapter.providerInfo('codex-sub').name, 'ChatGPT Subscription');
  assert.ok(logs.info.some((m) => m.includes('codex-sub')));
});

test('the registered adapter lists codex catalog models', async () => {
  const { ctx, registrations } = mockCtx();
  apply(ctx, { modelDiscovery: 'off' });
  const models = await registrations[0].adapter.listModels('openai-codex');
  assert.ok(models.length > 0);
  assert.ok(models.every((m) => m.provider === 'openai-codex' && typeof m.id === 'string' && typeof m.name === 'string'));
});

test('resolveModel reports catalog capacities and reasoning efforts', async () => {
  const { ctx, registrations } = mockCtx();
  apply(ctx, { modelDiscovery: 'off' });
  const adapter = registrations[0].adapter;
  const catalog = await adapter.listModels('openai-codex');
  const info = await adapter.resolveModel('openai-codex', catalog[0].id);
  assert.equal(info.provider, 'openai-codex');
  assert.ok(info.context.contextWindow > 0);
  assert.ok(Array.isArray(info.reasoning.efforts), 'reasoning models advertise efforts');
});

test('the registered adapter satisfies the prepareCall contract', async () => {
  // The harness calls registration.adapter.prepareCall() before every turn; an
  // adapter without it kills every ChatGPT model with
  // "registration.adapter.prepareCall is not a function" at turn start.
  const { ctx, registrations } = mockCtx();
  apply(ctx, { modelDiscovery: 'off' });
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
  apply(ctx, { modelDiscovery: 'off' });
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
  apply(ctx, { modelDiscovery: 'off' });
  assert.doesNotThrow(() => assertAdapterContract(registrations[0].adapter));
});

test('new installations default to DSH-managed credentials', () => {
  assert.equal(Config.dict.storage.meta.default, 'dsh');
});

test('the credential source is the one live-editable config field', () => {
  // Harness 0.1.7's settings layer writes profile configuration, and a field is
  // editable only when the schema marks it `.volatile()`. `storage` is the one
  // field the Web card changes while the route serves; without the marker the
  // card's switch dies with `Config field "storage" is not volatile`.
  assert.equal(Config.dict.storage.meta.volatile, true);
  for (const [key, field] of Object.entries(Config.dict)) {
    if (key === 'storage') continue;
    assert.equal(field.meta.volatile, undefined, `${key} stays ordinary configuration`);
  }
});

test('the card persists the credential source through the settings layer', async () => {
  // 0.1.7 removed settings namespaces: a write is addressed to the profile
  // entry's id, so the entry id — not a package-chosen namespace — must reach
  // settings.update, or the write fails with `No configurable plugin entry`.
  const { ctx, services, settingsWrites } = mockCtx({ typert: true });
  apply(ctx, { modelDiscovery: 'off' });
  const gateway = services.codexAuth;
  assert.ok(gateway, 'the typert gateway mounts when typert is present');
  await gateway.selectStorage('codex');
  assert.deepEqual(settingsWrites, [{ ns: 'llm-openai-codex', patch: { storage: 'codex' } }]);
});

test('the card is the entry own configuration page', () => {
  // Without this the settings layer also auto-generates a form for the same
  // volatile field, giving the one switch two competing surfaces.
  const configured = [];
  const { ctx } = mockCtx();
  ctx.settings.configure = (presentation, owner) => {
    configured.push({ presentation, owner });
    return () => {};
  };
  apply(ctx, { modelDiscovery: 'off' });
  assert.equal(configured.length, 1);
  assert.equal(configured[0].presentation.auto, false);
  assert.equal(configured[0].owner, ctx.fiber);
});

test('the registered adapter answers the token meter imageRequestPricing probe', () => {
  // dsh-llm calls adapter.imageRequestPricing() unguarded from the token meter.
  // The adapter base class answers "this route declares no pricing", so the
  // seam holds without this package supplying anything; the assertion is here
  // because a base-class change would surface as a priced-request crash.
  const { ctx, registrations } = mockCtx();
  apply(ctx, { modelDiscovery: 'off' });
  const adapter = registrations[0].adapter;
  assert.equal(typeof adapter.imageRequestPricing, 'function');
  assert.equal(adapter.imageRequestPricing('openai-codex', KNOWN), undefined);
});

test('the built profile carries the modelErrors diagnostics map', () => {
  // The resolved pi-ai profile requires a per-model diagnostics map and the
  // adapter reads profile.modelErrors.get(model) unguarded in modelOf — which
  // runs on every resolveModel, prepareCall, and stream. This package builds
  // the profile directly, so it must carry the same empty map the settings
  // resolver produces; without it the first turn dies with
  // "Cannot read properties of undefined (reading 'get')".
  const { profiles } = resolveRoute({});
  const profile = profiles.get('openai-codex');
  assert.ok(profile.modelErrors instanceof Map, 'modelErrors is a Map');
  assert.equal(profile.modelErrors.size, 0, 'the route declares no model failures');
  // The discovery-driven rebuild must keep the member too.
  const discovered = resolveRoute({}, { getModels: () => [] });
  assert.ok(discovered.profiles.get(discovered.route).modelErrors instanceof Map);
});

test('plugin identity matches the composition contract', () => {
  assert.equal(name, 'llm-openai-codex');
  assert.deepEqual(inject, ['llm', 'settings', 'typert']);
});

test('a stream resolves the auth file before any network request', async () => {
  const { ctx, registrations } = mockCtx();
  apply(ctx, { authPath: '/nonexistent/auth.json', modelDiscovery: 'off' });
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
    apply(ctx, { authPath: scratch.path, modelDiscovery: 'off' });
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

test('an image request sends a valid attachment target', async () => {
  const scratch = await scratchAuthFile(codexCliDocument({ expMs: Date.now() + HOUR, accountId: 'acct-live' }));
  const attachments = {
    // Harness 0.1.7 turns the route's pixel budget into concrete target
    // dimensions per attachment, so a profile without requestImagePixelBudget
    // or requestImageMaxBytes reaches this seam as an unusable target.
    async readImageRequest(_ref, target) {
      for (const key of ['width', 'height', 'maxBytes']) {
        if (!Number.isSafeInteger(target[key]) || target[key] <= 0) {
          throw new Error(`Image request ${key} must be a positive integer.`);
        }
      }
      throw new Error('IMAGE_POLICY_ACCEPTED');
    },
  };
  try {
    const { ctx, registrations } = mockCtx({ attachments });
    apply(ctx, { authPath: scratch.path, modelDiscovery: 'off' });
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

test('discovery off warns about unknown config.models ids at registration', () => {
  const { ctx, logs } = mockCtx();
  apply(ctx, { modelDiscovery: 'off', models: ['gpt-9000-imaginary', KNOWN] });
  assert.ok(
    logs.warn.some((m) => m.includes('gpt-9000-imaginary') && m.includes('model discovery')),
    'names the unservable id and the remedy',
  );
});

test('model discovery adopts a cached manifest and serves a model the catalog lacks', async () => {
  // End-to-end through apply(): the persisted manifest from an earlier fetch
  // (or another process) must reach the picker without any network access.
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-codex-models-'));
  const cachePath = join(scratch, 'models-cache.json');
  const manifest = {
    clientVersion: '1.0.0',
    fetchedAt: Date.now() - 60_000,
    models: [{
      slug: 'gpt-9000-imaginary',
      display_name: 'Imaginary 9000',
      context_window: 400_000,
      visibility: 'list',
      priority: 1,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
    }],
  };
  await writeFile(cachePath, JSON.stringify(manifest));
  try {
    const { ctx, registrations } = mockCtx();
    apply(ctx, { modelDiscovery: 'auto', modelRefreshMs: 0, modelCachePath: cachePath, authPath: '/nonexistent/auth.json' });
    const adapter = registrations[0].adapter;
    let ids = [];
    for (let i = 0; i < 200 && !ids.includes('gpt-9000-imaginary'); i += 1) {
      ids = (await adapter.listModels('openai-codex')).map((m) => m.id);
      if (!ids.includes('gpt-9000-imaginary')) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(ids.includes('gpt-9000-imaginary'), 'the cached manifest model reaches the picker');
    assert.ok(ids.includes(KNOWN), 'the installed catalog still serves alongside it');
    const info = await adapter.resolveModel('openai-codex', 'gpt-9000-imaginary');
    assert.equal(info.name, 'Imaginary 9000');
    assert.equal(info.context.contextWindow, 400_000);
    assert.ok(info.reasoning.efforts.length > 0, 'manifest efforts become selectable levels');
    // The not-signed-in refresh must not have clobbered the adopted cache.
    assert.ok(
      (await adapter.listModels('openai-codex')).some((m) => m.id === 'gpt-9000-imaginary'),
      'a missing credential keeps the cached list',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
