/**
 * Unit tests for live Codex model discovery (lib/models.js): manifest
 * fetching against a stub backend, catalog merging and synthesis, per-model
 * overrides, the disk cache, and the registry's failure behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  CODEX_MODELS_URL,
  CodexModelRegistry,
  MODEL_FETCH_FAILED,
  applyModelOverride,
  fetchCodexModelManifest,
  mergeCodexModels,
  synthesizeCodexModel,
  thinkingLevelMapFor,
} from '../lib/models.js';
import { LlmError } from '@deepseek-ai/dsh-llm';

const catalogModels = builtinProviders().find((provider) => provider.id === 'openai-codex').getModels();
const KNOWN = catalogModels[0].id;

/** A manifest entry shaped like the backend's, with the fields discovery reads. */
function manifestEntry(overrides = {}) {
  return {
    slug: 'gpt-9000-imaginary',
    display_name: 'Imaginary 9000',
    description: 'A model the installed catalog has not caught up with',
    context_window: 400_000,
    visibility: 'list',
    priority: 1,
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
    ...overrides,
  };
}

/** A fetch stub answering the models manifest endpoint. */
function manifestFetch(entries, { status = 200, ok = status >= 200 && status < 300, body } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (body !== undefined) return { ok, status, json: async () => body };
    return { ok, status, json: async () => ({ models: entries }) };
  };
  impl.calls = calls;
  return impl;
}

function registry({ manifest, fetchImpl, ...options } = {}) {
  const warnings = [];
  const instance = new CodexModelRegistry({
    catalogModels,
    cachePath: join(options.cachePath ?? '/nonexistent', 'unused.json'),
    getAccessToken: options.getAccessToken ?? (async () => 'token-jwt'),
    getAccountId: options.getAccountId ?? (async () => 'acct-1'),
    fetchImpl: fetchImpl ?? manifestFetch(manifest ?? [manifestEntry()]),
    onWarn: (detail) => warnings.push(detail),
    ...options,
  });
  return { instance, warnings };
}

test('the manifest request authenticates like a Codex client and reports a client version', async () => {
  const fetchImpl = manifestFetch([manifestEntry()]);
  await fetchCodexModelManifest({ accessToken: 'token-jwt', accountId: 'acct-9', fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.ok(url.startsWith(`${CODEX_MODELS_URL}?client_version=`), 'carries the client_version query');
  assert.equal(init.headers.Authorization, 'Bearer token-jwt');
  assert.equal(init.headers['ChatGPT-Account-Id'], 'acct-9');
  assert.equal(init.headers.Accept, 'application/json');
});

test('the manifest request omits the account header when the credential discloses none', async () => {
  const fetchImpl = manifestFetch([manifestEntry()]);
  await fetchCodexModelManifest({ accessToken: 'token-jwt', accountId: undefined, fetchImpl });
  assert.equal(fetchImpl.calls[0].init.headers['ChatGPT-Account-Id'], undefined);
});

test('manifest failures are LlmErrors that never quote the response body', async () => {
  const notOk = await fetchCodexModelManifest({ accessToken: 't', fetchImpl: manifestFetch([], { status: 503 }) }).then(
    () => assert.fail('expected rejection'),
    (error) => error,
  );
  assert.equal(notOk.code, MODEL_FETCH_FAILED);
  assert.ok(notOk instanceof LlmError);
  assert.ok(notOk.message.includes('503'));

  const network = await fetchCodexModelManifest({
    accessToken: 't',
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  }).then(() => assert.fail('expected rejection'), (error) => error);
  assert.equal(network.code, MODEL_FETCH_FAILED);

  const malformed = await fetchCodexModelManifest({ accessToken: 't', fetchImpl: manifestFetch([], { body: { unexpected: true } }) }).then(
    () => assert.fail('expected rejection'),
    (error) => error,
  );
  assert.equal(malformed.code, MODEL_FETCH_FAILED);

  const brokenJson = await fetchCodexModelManifest({
    accessToken: 't',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('unexpected end'); } }),
  }).then(() => assert.fail('expected rejection'), (error) => error);
  assert.equal(brokenJson.code, MODEL_FETCH_FAILED);
});

test('the manifest is ordered by backend priority, then slug, and drops unusable entries', async () => {
  const entries = await fetchCodexModelManifest({
    accessToken: 't',
    fetchImpl: manifestFetch([
      manifestEntry({ slug: 'b-slug', priority: 5 }),
      manifestEntry({ slug: 'a-slug', priority: 5 }),
      manifestEntry({ slug: 'z-slug', priority: 1 }),
      manifestEntry({ slug: '' }), // unusable: no slug
      null, // unusable: not an object
      manifestEntry({ slug: 'no-slug-field', slug: undefined }),
    ]),
  });
  assert.deepEqual(entries.map((entry) => entry.slug), ['z-slug', 'a-slug', 'b-slug']);
});

test('thinkingLevelMapFor pins every level the manifest decides', () => {
  assert.deepEqual(thinkingLevelMapFor(['low', 'medium', 'high']), {
    minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null,
  });
  assert.deepEqual(thinkingLevelMapFor(['minimal', 'high', 'xhigh', 'max']), {
    minimal: 'minimal', low: null, medium: null, high: 'high', xhigh: 'xhigh', max: 'max',
  });
  assert.deepEqual(thinkingLevelMapFor([]), {
    minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
  });
  // `off` never appears: selecting it omits the reasoning parameter.
  assert.equal('off' in thinkingLevelMapFor(['low']), false);
});

test('synthesized models speak the catalog wire protocol with sibling traits', () => {
  const model = synthesizeCodexModel(manifestEntry(), catalogModels);
  assert.equal(model.id, 'gpt-9000-imaginary');
  assert.equal(model.name, 'Imaginary 9000');
  assert.equal(model.api, 'openai-codex-responses');
  assert.equal(model.provider, 'openai-codex');
  assert.equal(model.baseUrl, 'https://chatgpt.com/backend-api');
  assert.equal(model.contextWindow, 400_000);
  assert.equal(model.maxTokens, 128_000, 'the output cap falls back below the context window');
  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingLevelMap.high, 'high');
  assert.deepEqual(model.input, ['text', 'image'], 'a tied family sibling prefers image-capable catalog entries');
  assert.ok(model.compat, 'compat comes from the closest sibling');
});

test('a manifest entry without reasoning levels synthesizes a non-reasoning model', () => {
  const model = synthesizeCodexModel(manifestEntry({ supported_reasoning_levels: [] }), catalogModels);
  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
});

test('a new sibling of an existing family inherits that exact sibling, not a family-wide guess', () => {
  const gpt54 = catalogModels.find((model) => model.id === 'gpt-5.4');
  const model = synthesizeCodexModel(manifestEntry({ slug: 'gpt-5.4-nano' }), catalogModels);
  assert.deepEqual(model.input, gpt54.input);
  assert.deepEqual(model.compat, gpt54.compat, 'two-segment prefix beats the generic root tie');
});

test('merging keeps catalog entries for known slugs and appends unmentioned catalog models', () => {
  const { models } = mergeCodexModels({
    catalogModels,
    manifestEntries: [manifestEntry({ slug: KNOWN })],
  });
  const kept = models.find((model) => model.id === KNOWN);
  assert.equal(kept, catalogModels.find((model) => model.id === KNOWN), 'known slugs keep the exact catalog entry');
  assert.ok(models.some((model) => model.id === 'gpt-5.4'), 'catalog models the manifest never mentions survive');
});

test('merging synthesizes unknown slugs and drops models the backend explicitly hides', () => {
  const { models } = mergeCodexModels({
    catalogModels,
    manifestEntries: [
      manifestEntry({ slug: 'gpt-9000-imaginary' }),
      manifestEntry({ slug: 'gpt-5.4', visibility: 'hide' }),
    ],
  });
  assert.ok(models.some((model) => model.id === 'gpt-9000-imaginary'));
  assert.equal(models.some((model) => model.id === 'gpt-5.4'), false, 'an explicit per-account hide removes the picker entry');
  // An older/partial manifest must not remove anything it does not mention.
  const partial = mergeCodexModels({ catalogModels, manifestEntries: [manifestEntry({ slug: KNOWN })] }).models;
  assert.deepEqual(
    partial.filter((model) => model.id === 'gpt-5.4').length,
    1,
  );
});

test('merging honors the models filter and reports the ids nothing serves', () => {
  const { models, unknownFilterIds } = mergeCodexModels({
    catalogModels,
    manifestEntries: [manifestEntry()],
    filter: new Set(['gpt-9000-imaginary', 'gpt-9000-never']),
  });
  assert.deepEqual(models.map((model) => model.id), ['gpt-9000-imaginary']);
  assert.deepEqual(unknownFilterIds, ['gpt-9000-never']);
});

test('overrides reshape resolved models; a non-reasoning declaration strips thinking levels', () => {
  const renamed = applyModelOverride(catalogModels[0], { name: 'Renamed', contextWindow: 99, maxTokens: 9, input: ['text'], compat: { supportsToolSearch: false } });
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.contextWindow, 99);
  assert.equal(renamed.maxTokens, 9);
  assert.deepEqual(renamed.input, ['text']);
  assert.equal(renamed.compat.supportsToolSearch, false);

  const flat = applyModelOverride({ ...catalogModels[0], reasoning: true, thinkingLevelMap: { low: 'low' } }, { reasoningEfforts: false });
  assert.equal(flat.reasoning, false);
  assert.equal(flat.thinkingLevelMap, undefined);

  const remapped = applyModelOverride(catalogModels[0], { reasoningEfforts: { low: 'calm', high: 'wild' } });
  assert.equal(remapped.thinkingLevelMap.low, 'calm');
  assert.equal(remapped.thinkingLevelMap.high, 'wild');
  assert.equal(remapped.thinkingLevelMap.medium, null, 'undeclared levels pin unsupported');

  const withOff = applyModelOverride(catalogModels[0], { reasoningEfforts: { off: 'none', low: 'low' } });
  assert.equal(withOff.thinkingLevelMap.off, 'none');

  // A declaration with no level beyond `off` cannot describe a reasoning
  // model, so it is ignored rather than stripping the model's capability.
  const offOnly = applyModelOverride(catalogModels[0], { reasoningEfforts: { off: null } });
  assert.deepEqual(offOnly.thinkingLevelMap, catalogModels[0].thinkingLevelMap);
  assert.equal(offOnly.reasoning, catalogModels[0].reasoning);
});

test('refresh adopts the manifest, marks the change, and persists the cache', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-codex-models-'));
  try {
    const { instance } = registry({ manifest: [manifestEntry()], cachePath: undefined, fetchImpl: manifestFetch([manifestEntry()]) });
    instance.cachePath = join(scratch, 'models.json');
    const before = instance.snapshot();
    assert.deepEqual(before, { count: catalogModels.length, source: 'catalog', fetchedAt: null, error: null });
    const status = await instance.refresh();
    assert.equal(status.changed, true);
    assert.equal(status.source, 'manifest');
    assert.equal(status.error, null);
    assert.ok(instance.models.some((model) => model.id === 'gpt-9000-imaginary'));
    const cached = JSON.parse(await readFile(instance.cachePath, 'utf8'));
    assert.equal(cached.clientVersion, instance.clientVersion);
    assert.deepEqual(cached.models.map((entry) => entry.slug), ['gpt-9000-imaginary']);
    // A second refresh answering the same manifest is not a change.
    const again = await instance.refresh();
    assert.equal(again.changed, false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('concurrent refreshes share one fetch', async () => {
  const fetchImpl = manifestFetch([manifestEntry()]);
  const { instance } = registry({ fetchImpl });
  const [a, b] = await Promise.all([instance.refresh(), instance.refresh()]);
  assert.equal(fetchImpl.calls.length, 1, 'the inflight promise is shared');
  assert.equal(a.count, b.count);
});

test('a fetch failure warns and keeps the served list', async () => {
  let failing = true;
  const flaky = manifestFetch([manifestEntry()]);
  const flip = async (url, init) => (failing ? { ok: false, status: 500, json: async () => ({ models: [] }) } : flaky(url, init));
  const { instance, warnings } = registry({ fetchImpl: flip });
  const status = await instance.refresh();
  assert.equal(status.changed, false);
  assert.equal(status.source, 'catalog');
  assert.ok(status.error.includes('500'));
  assert.equal(instance.models.length, catalogModels.length);
  assert.equal(warnings.length, 1);
  // Recovery clears the error and adopts what the backend now answers.
  failing = false;
  const recovered = await instance.refresh();
  assert.equal(recovered.error, null);
  assert.equal(recovered.source, 'manifest');
});

test('a missing credential is a quiet not-signed-in state, not a failure', async () => {
  const { instance, warnings } = registry({
    getAccessToken: async () => { const error = new LlmError('no credentials', 'MISSING_CREDENTIAL'); throw error; },
  });
  const status = await instance.refresh();
  assert.equal(status.changed, false);
  assert.equal(status.error, null);
  assert.deepEqual(warnings, []);
});

test('loadCache adopts a persisted manifest without touching the network', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-codex-models-'));
  try {
    const cachePath = join(scratch, 'models.json');
    await writeFile(cachePath, JSON.stringify({ fetchedAt: 1_700_000_000_000, models: [manifestEntry()] }));
    const fetchStub = manifestFetch([]);
    const { instance } = registry({ fetchImpl: fetchStub });
    instance.cachePath = cachePath;
    const changed = await instance.loadCache();
    assert.equal(changed, true);
    assert.equal(instance.snapshot().source, 'cache');
    assert.equal(instance.snapshot().fetchedAt, 1_700_000_000_000);
    assert.ok(instance.models.some((model) => model.id === 'gpt-9000-imaginary'));
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('loadCache tolerates a missing and a corrupt cache', async () => {
  const warnings = [];
  const missing = new CodexModelRegistry({
    catalogModels,
    cachePath: '/nonexistent/models.json',
    getAccessToken: async () => 't',
    getAccountId: async () => undefined,
    fetchImpl: manifestFetch([]),
    onWarn: (detail) => warnings.push(detail),
  });
  assert.equal(await missing.loadCache(), false);
  assert.equal(missing.models.length, catalogModels.length);

  const scratch = await mkdtemp(join(tmpdir(), 'dsh-codex-models-'));
  try {
    const corrupt = new CodexModelRegistry({
      catalogModels,
      cachePath: join(scratch, 'corrupt.json'),
      getAccessToken: async () => 't',
      getAccountId: async () => undefined,
      fetchImpl: manifestFetch([]),
      onWarn: (detail) => warnings.push(detail),
    });
    await writeFile(join(scratch, 'corrupt.json'), '{not json');
    assert.equal(await corrupt.loadCache(), false);
    assert.equal(corrupt.models.length, catalogModels.length);
    assert.equal(warnings.length, 1, 'the corrupt cache warns once');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
