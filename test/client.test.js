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

test('registers the Settings card before the optional Remote bridge settles', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let handoff;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { handoff = value; } } } });
  const client = handoff.factory((specifier) => {
    if (specifier === 'react') return { createElement() {} };
    throw new Error(`Unexpected client dependency: ${specifier}`);
  });
  let releaseMount;
  const mount = new Promise((resolve) => { releaseMount = resolve; });
  let card;
  const started = client.apply({
    effect(callback) { return callback(); },
    remote: { $mount: () => mount },
    slots: {
      inject(_name, callback) { callback(); },
      register(options) { card = options; return () => {}; },
    },
  });
  await Promise.resolve();
  assert.equal(card?.key, 'llm-openai-codex');
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
      register(options) { card = options; return () => {}; },
    },
  });
  assert.deepEqual(await card.inject().remote.status(), { ok: true, value: { connected: true } });
});
