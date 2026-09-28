/** Regression coverage for the browser loader entry's factory-form CJS contract. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('browser loader entry materializes as a factory-form CommonJS module', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let handoff;
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value) {
          handoff = value;
        },
      },
    },
  });

  assert.equal(handoff.id, 'dsh-llm-openai-codex');
  const client = handoff.factory((specifier) => {
    if (specifier === 'react') return { createElement() {} };
    throw new Error(`Unexpected client dependency: ${specifier}`);
  });
  assert.deepEqual(Object.keys(client).sort(), ['apply', 'inject']);
  assert.deepEqual([...client.inject], ['slots', 'remote']);
});

test('browser factory assigns exports through its local module object', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*exports\.(?:apply|inject)\s*=/m);
  assert.match(source, /module\.exports\.(?:apply|inject)\s*=/);
  assert.match(source, /'aria-expanded': open/);
  assert.match(source, /onClick: \(\) => setOpen\(!open\)/);
  assert.match(source, /padding: '14px 16px'/);
  assert.match(source, /fontSize: 15, fontWeight: 600/);
  assert.match(source, /window\.open\('', 'dsh-chatgpt-login'/);
  assert.match(source, /popup\?\.location\.assign\(login\.url\)/);
  assert.doesNotMatch(source, /snapshot\.accountId/);
});

test('registers the Plugins-page cards before the optional Remote bridge settles', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let handoff;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { handoff = value; } } } });
  const client = handoff.factory((specifier) => {
    if (specifier === 'react') return { createElement() {} };
    throw new Error(`Unexpected client dependency: ${specifier}`);
  });
  let releaseMount;
  const mount = new Promise((resolve) => { releaseMount = resolve; });
  const registrations = [];
  const injectedSlots = [];
  const started = client.apply({
    effect(callback) { return callback(); },
    remote: { $mount: () => mount },
    slots: {
      inject(name, callback) { injectedSlots.push(name); callback(); },
      register(options) { registrations.push(options); return () => {}; },
    },
  });
  await Promise.resolve();
  // Harness 0.1.7 configures bundles only on the Plugins page. The card must
  // be registered on all three keyed slots before the Remote mount settles,
  // so a slow or failed bridge never hides the login surface.
  assert.deepEqual(injectedSlots, ['plugins.row.config', 'plugins.bundle.config', 'plugins.bundle.activation']);
  assert.deepEqual(registrations.map(({ name, key }) => `${name} ${key}`), [
    'plugins.row.config dsh-llm-openai-codex#llm-openai-codex',
    'plugins.bundle.config dsh-llm-openai-codex',
    'plugins.bundle.activation dsh-llm-openai-codex',
  ]);
  releaseMount(async () => {});
  await started;
});

test('OAuth facade resolves its dynamically mounted Remote through ctx.get()', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let handoff;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { handoff = value; } } } });
  const client = handoff.factory((specifier) => {
    if (specifier === 'react') return { createElement() {} };
    throw new Error(`Unexpected client dependency: ${specifier}`);
  });
  let card;
  const target = { status: async () => ({ ok: true, value: { connected: true } }) };
  const remote = { $mount: async () => async () => {} };
  Object.defineProperty(remote, 'codexAuth', {
    get() { throw new Error('cannot get property "remote.codexAuth" without inject'); },
  });
  client.apply({
    effect(callback) { return callback(); },
    get(key) { return key === 'remote.codexAuth' ? target : undefined; },
    remote,
    slots: {
      inject(_name, callback) { callback(); },
      register(options) { if (options.name === 'plugins.row.config') card = options; return () => {}; },
    },
  });
  assert.deepEqual(await card.inject().remote.status(), { ok: true, value: { connected: true } });
});

test('the activation prompt wires Connect now and Later to the Plugins page callbacks', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let handoff;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { handoff = value; } } } });
  const elements = [];
  const client = handoff.factory((specifier) => {
    if (specifier === 'react') return { createElement: (type, props, ...children) => { elements.push({ type, props, children }); return null; } };
    throw new Error(`Unexpected client dependency: ${specifier}`);
  });
  const components = new Map();
  client.apply({
    effect(callback) { return callback(); },
    get() { return undefined; },
    remote: { $mount: async () => async () => {} },
    slots: {
      inject(_name, callback) { callback(); },
      register(options, component) { components.set(options.name, component); return () => {}; },
    },
  });
  const onOpenDetails = () => {};
  const onDismiss = () => {};
  elements.length = 0;
  components.get('plugins.bundle.activation')({ packageName: 'dsh-llm-openai-codex', onOpenDetails, onDismiss });
  const buttons = elements.filter((element) => element.type === 'button');
  assert.equal(buttons.filter((element) => element.props.onClick === onOpenDetails).length, 1);
  assert.equal(buttons.filter((element) => element.props.onClick === onDismiss).length, 1);
  assert.match(JSON.stringify(elements), /ChatGPT subscription/);
});

test('a pending login shows a countdown, a reopen link, and a cancel action', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  // The pending status must carry the host's authorization URL: after a page
  // reload the card's own browserUrl state is gone, and without this link a
  // closed browser left the card stuck with no escape hatch.
  assert.match(source, /pending\.url \?\? browserUrl/);
  assert.match(source, /pendingCountdown\(pending\.expiresAt\)/);
  assert.match(source, /Cancel this login/);
  assert.match(source, /remote\.cancelLogin\(\)/);
  assert.match(source, /'beginDeviceLogin', 'cancelLogin', 'disconnect'/);
  // The model row: a manual refresh action, the two new facade methods, and
  // the status line fed by the modelsStatus poll.
  assert.match(source, /Refresh model list/);
  assert.match(source, /remote\.refreshModels\(\)/);
  assert.match(source, /call\('modelsStatus', \[\], modelsStatus\)/);
  assert.match(source, /call\('refreshModels', \[\], modelsStatus\)/);
  // 0.1.7 rejects any strict codec without a create() factory, at both ends.
  assert.match(source, /create: \(\) => schema/);
});
