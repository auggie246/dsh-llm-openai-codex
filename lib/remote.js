/**
 * Host Typert contribution for the browser-only Codex OAuth controls.
 *
 * The host loader discovers this package's `./typert` export automatically;
 * the client half mounts the matching `./remote` contribution. Schemas are
 * intentionally tiny, strict JSON codecs rather than a generated dependency:
 * Typert's runtime contract is `schema.parse(value)`, and the loader's zod-v4
 * shape check is satisfied by its `_zod` marker. Every exposed value is
 * detached, JSON-safe, and contains no token material.
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

export const PACKAGE = 'dsh-llm-openai-codex';
export const SERVICE = 'codexAuth';

function fail(message) {
  throw new Error(`dsh-llm-openai-codex remote: ${message}`);
}

/** Minimal strict codec accepted by Typert on both Host and Client. */
function codec(typeSymbol, parse) {
  return Object.freeze({ mode: 'strict', typeSymbol, schema: Object.freeze({ _zod: {}, parse }) });
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function string(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value;
}
function bool(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}
function nullable(value, parser, label) {
  return value === null ? null : parser(value, label);
}
function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  return value;
}
function enumValue(value, values, label) {
  if (!values.includes(value)) fail(`${label} is invalid`);
  return value;
}
function onlyKeys(object, keys, label) {
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail(`${label}.${key} is not allowed`);
}

export const StorageCodec = codec(`${PACKAGE}/StorageSelection`, (value) => enumValue(value, ['dsh', 'codex'], 'storage'));
export const StatusCodec = codec(`${PACKAGE}/CodexAuthStatus`, (value) => {
  const v = record(value, 'status');
  onlyKeys(v, ['storage', 'source', 'connected', 'expiresAt', 'pending', 'error'], 'status');
  const pending = nullable(v.pending, (p) => {
    const item = record(p, 'pending');
    onlyKeys(item, ['kind', 'expiresAt', 'userCode', 'verificationUri'], 'pending');
    enumValue(item.kind, ['browser', 'device'], 'pending.kind');
    finite(item.expiresAt, 'pending.expiresAt');
    if (item.kind === 'device') {
      string(item.userCode, 'pending.userCode');
      string(item.verificationUri, 'pending.verificationUri');
    }
    return { ...item };
  }, 'status.pending');
  return {
    storage: enumValue(v.storage, ['dsh', 'codex', 'custom'], 'status.storage'),
    source: string(v.source, 'status.source'),
    connected: bool(v.connected, 'status.connected'),
    expiresAt: nullable(v.expiresAt, finite, 'status.expiresAt'),
    pending,
    error: nullable(v.error, string, 'status.error'),
  };
});
export const BrowserLoginCodec = codec(`${PACKAGE}/BrowserLogin`, (value) => {
  const v = record(value, 'browser login');
  onlyKeys(v, ['url'], 'browser login');
  return { url: string(v.url, 'browser login.url') };
});
export const DeviceLoginCodec = codec(`${PACKAGE}/DeviceLogin`, (value) => {
  const v = record(value, 'device login');
  onlyKeys(v, ['kind', 'expiresAt', 'userCode', 'verificationUri'], 'device login');
  return {
    kind: enumValue(v.kind, ['device'], 'device login.kind'),
    expiresAt: finite(v.expiresAt, 'device login.expiresAt'),
    userCode: string(v.userCode, 'device login.userCode'),
    verificationUri: string(v.verificationUri, 'device login.verificationUri'),
  };
});

const results = {
  status: { mode: 'strict', typeSymbol: `${PACKAGE}/CodexAuthStatus`, schema: StatusCodec.schema },
  browser: { mode: 'strict', typeSymbol: `${PACKAGE}/BrowserLogin`, schema: BrowserLoginCodec.schema },
  device: { mode: 'strict', typeSymbol: `${PACKAGE}/DeviceLogin`, schema: DeviceLoginCodec.schema },
};
const storageParameter = {
  name: 'storage',
  wire: 'storage',
  source: 'json',
  codec: { mode: 'strict', typeSymbol: `${PACKAGE}/StorageSelection`, schema: StorageCodec.schema },
};

function invocation(method, parameters, result) {
  return {
    id: `${PACKAGE}#${SERVICE}/${method}`,
    service: SERVICE,
    namespace: SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result,
  };
}

/** Host manifest discovered by dsh-typert-loader from this package's ./typert export. */
export const TYPERT = Object.freeze({
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [
    invocation('status', [], results.status),
    invocation('selectStorage', [storageParameter], results.status),
    invocation('beginBrowserLogin', [], results.browser),
    invocation('beginDeviceLogin', [], results.device),
    invocation('disconnect', [], results.status),
  ],
  model: { services: [], events: [], objects: [] },
});

/** Client manifest mounted by the package's browser half. */
export const TYPERT_REMOTE = Object.freeze({
  package: PACKAGE,
  descriptors: TYPERT.invocations,
});

const remoteInitializers = [];
function markRemote(ctor, method) {
  Remote(method)(ctor.prototype[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      remoteInitializers.push(initializer);
    },
  });
}

/** Typert service wrapper over the controller's small operational interface. */
export class CodexAuthGateway extends TypertRemoteService {
  constructor(ctx, controller) {
    super(ctx, SERVICE);
    this.controller = controller;
    for (const initializer of remoteInitializers) initializer.call(this);
  }
  status() { return this.controller.status(); }
  selectStorage(storage) { return this.controller.selectStorage(storage); }
  beginBrowserLogin() { return this.controller.beginBrowserLogin(); }
  beginDeviceLogin() { return this.controller.beginDeviceLogin(); }
  disconnect() { return this.controller.disconnect(); }
}
for (const method of ['status', 'selectStorage', 'beginBrowserLogin', 'beginDeviceLogin', 'disconnect']) markRemote(CodexAuthGateway, method);
