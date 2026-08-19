/**
 * Interactive OpenAI Codex OAuth controller.
 *
 * This is the plugin's deep module: callers only ask for a status snapshot,
 * begin one browser/device login, select a credential source, or disconnect.
 * PKCE, callback-server lifecycle, device polling, token exchange, safe
 * persistence, refresh-file cache invalidation, and all failure cleanup stay
 * behind that small interface.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { unlink } from 'node:fs/promises';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import {
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  CodexAuthFile,
  accountIdOf,
  codexAuthDocument,
  createCodexAuth,
  defaultCodexAuthPath,
  parseAuthDocument,
  writeAuthDocument,
} from './auth.js';

export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_DEVICE_USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
export const CODEX_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
export const CODEX_DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device';
export const BROWSER_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
export const OAUTH_SCOPE = 'openid profile email offline_access';
const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const BROWSER_TIMEOUT_MS = 10 * 60_000;

/** Base64url PKCE verifier/challenge pair. */
export function createPkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** One browser authorization URL, including Codex's required flow flags. */
export function createAuthorizationUrl({ state, challenge }) {
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', BROWSER_REDIRECT_URI);
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'dsh');
  return url.toString();
}

/** Exchange either browser or device authorization code for OAuth tokens. */
export async function exchangeAuthorizationCode({ code, verifier, redirectUri, fetchImpl = fetch }) {
  const response = await fetchImpl(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    // This message crosses the package-private Remote to the browser; never
    // relay an OAuth response body, which may contain implementation details.
    throw new Error(`OpenAI authorization exchange failed (${response.status})`);
  }
  const json = await response.json();
  if (typeof json?.access_token !== 'string' || typeof json?.refresh_token !== 'string' || typeof json?.expires_in !== 'number') {
    throw new Error('OpenAI authorization exchange returned no usable token pair');
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    idToken: typeof json.id_token === 'string' ? json.id_token : undefined,
    accountId: accountIdOf(json.access_token),
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/** DSH's owned credential file (not the Codex CLI's). */
export function defaultDshCodexAuthPath() {
  return dshHomePath('credentials', 'openai-codex.json');
}

/** Safe callback success/error pages; no auth code or token is rendered. */
function callbackPage(success, message) {
  const escaped = String(message).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!doctype html><html><head><meta charset="utf-8"><title>DSH ChatGPT connection</title></head><body><main><h1>${success ? 'ChatGPT connected' : 'Connection failed'}</h1><p>${escaped}</p><p>${success ? 'Return to DeepSeek Harness; you can close this window.' : 'Return to DeepSeek Harness and try again.'}</p></main></body></html>`;
}

function listenCallback(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    const fail = (error) => {
      server.close();
      reject(error);
    };
    server.once('error', fail);
    server.listen(1455, '127.0.0.1', () => {
      server.off('error', fail);
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Login cancelled'));
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('Login cancelled'));
    }, { once: true });
  });
}

/**
 * Owns the two credential sources and at most one interactive login. The
 * source selector is intentionally a callback: `ctx.settings` is the one
 * owner of persistence and can change live without rebuilding the LLM route.
 */
export class CodexOAuthController {
  /**
   * @param {object} options
   * @param {() => ('dsh'|'codex')} options.storage - current selected source.
   * @param {(storage: 'dsh'|'codex') => Promise<void>} options.setStorage - persist the source selection.
   * @param {string | undefined} options.customAuthPath - composition-owned path that disables the selector.
   * @param {number} options.refreshMarginMs
   * @param {(input: any, init?: any) => Promise<any>} [options.fetchImpl]
   * @param {string} [options.dshAuthPath]
   * @param {string} [options.codexAuthPath]
   */
  constructor(options) {
    this.storage = options.storage;
    this.setStorageValue = options.setStorage;
    this.customAuthPath = options.customAuthPath;
    this.refreshMarginMs = options.refreshMarginMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dshAuthPath = options.dshAuthPath ?? defaultDshCodexAuthPath();
    this.codexAuthPath = options.codexAuthPath ?? defaultCodexAuthPath();
    this.sources = new Map();
    this.pending = undefined;
    this.lastError = undefined;
  }

  /** Selected credential source, source label, and exact file path. */
  source() {
    if (this.customAuthPath !== undefined) return { storage: 'custom', label: 'Custom auth file', path: this.customAuthPath, writable: false };
    if (this.storage() === 'dsh') return { storage: 'dsh', label: 'DSH-managed credentials', path: this.dshAuthPath, writable: true };
    return { storage: 'codex', label: 'Shared Codex CLI credentials', path: this.codexAuthPath, writable: true };
  }

  authFile() {
    const { path } = this.source();
    let auth = this.sources.get(path);
    if (auth === undefined) {
      auth = createCodexAuth({ path, refreshMarginMs: this.refreshMarginMs, fetchImpl: this.fetchImpl });
      this.sources.set(path, auth);
    }
    return auth;
  }

  /** Per-model-request access token. Refresh remains in CodexAuthFile. */
  async getAccessToken() {
    return this.authFile().getAccessToken();
  }

  /** Detached, secret-free status for the Web card. */
  async status() {
    const source = this.source();
    let connected = false;
    let accountId = null;
    let expiresAt = null;
    let error = this.lastError ?? null;
    try {
      const credential = await this.authFile().ensureLoaded();
      connected = true;
      accountId = credential.credential.accountId ?? null;
      expiresAt = Number.isFinite(credential.credential.expiresAt) ? credential.credential.expiresAt : null;
    } catch (cause) {
      // Missing/invalid credentials are normal before the first login. Never
      // return a file error that might echo a user-configured absolute path.
      if (error === null) error = 'Not connected';
    }
    return {
      storage: source.storage,
      source: source.label,
      connected,
      accountId,
      expiresAt,
      pending: this.pending === undefined ? null : this.pending.view(),
      error,
    };
  }

  async selectStorage(storage) {
    if (this.customAuthPath !== undefined) throw new Error('This composition pins a custom authPath; remove authPath before choosing a managed source in Settings.');
    if (this.pending !== undefined) throw new Error('Finish or cancel the current ChatGPT login before changing credential storage.');
    if (storage !== 'dsh' && storage !== 'codex') throw new Error('Unknown credential storage selection');
    await this.setStorageValue(storage);
    this.lastError = undefined;
    return this.status();
  }

  async beginBrowserLogin() {
    this.requireWritableSource();
    if (this.pending !== undefined) throw new Error('A ChatGPT login is already in progress.');
    const { verifier, challenge } = createPkce();
    const state = randomBytes(16).toString('hex');
    let server;
    try {
      server = await listenCallback((request, response) => {
        void this.handleBrowserCallback(request, response, { state, verifier, server });
      });
    } catch (cause) {
      const code = /** @type {{code?: string}} */ (cause)?.code;
      if (code === 'EADDRINUSE') throw new Error('The OAuth callback port 1455 is already in use. Use Device code login below, or finish the other Codex login first.');
      throw new Error(`Could not start the local OAuth callback: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const expiresAt = Date.now() + BROWSER_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (this.pending?.kind === 'browser') this.finishPending('Browser login timed out. Try again or use Device code login.');
    }, BROWSER_TIMEOUT_MS);
    this.pending = {
      kind: 'browser',
      expiresAt,
      view: () => ({ kind: 'browser', expiresAt }),
      close: async () => {
        clearTimeout(timeout);
        await closeServer(server);
      },
    };
    this.lastError = undefined;
    return { url: createAuthorizationUrl({ state, challenge }) };
  }

  async handleBrowserCallback(request, response, expected) {
    const url = new URL(request.url ?? '/', BROWSER_REDIRECT_URI);
    if (url.pathname !== '/auth/callback') {
      response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(callbackPage(false, 'Callback route not found.'));
      return;
    }
    if (url.searchParams.get('state') !== expected.state) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(callbackPage(false, 'OAuth state did not match.'));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(callbackPage(false, 'OpenAI returned no authorization code.'));
      return;
    }
    try {
      await this.finishAuthorizationCode(code, expected.verifier, BROWSER_REDIRECT_URI);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(callbackPage(true, 'Your ChatGPT subscription is now connected.'));
      await this.finishPending();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.lastError = message;
      response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(callbackPage(false, message));
      await this.finishPending(message);
    }
  }

  async beginDeviceLogin() {
    this.requireWritableSource();
    if (this.pending !== undefined) throw new Error('A ChatGPT login is already in progress.');
    const response = await this.fetchImpl(CODEX_DEVICE_USER_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    });
    if (!response.ok) throw new Error(`OpenAI device-code request failed (${response.status})`);
    const json = await response.json();
    const intervalSeconds = typeof json?.interval === 'string' ? Number(json.interval) : json?.interval;
    if (typeof json?.device_auth_id !== 'string' || typeof json?.user_code !== 'string' || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
      throw new Error('OpenAI returned an invalid device-code response');
    }
    const abort = new AbortController();
    const pending = {
      kind: 'device',
      expiresAt: Date.now() + DEVICE_CODE_TIMEOUT_MS,
      deviceAuthId: json.device_auth_id,
      userCode: json.user_code,
      intervalMs: Math.max(1_000, intervalSeconds * 1000),
      abort,
      view: () => ({ kind: 'device', expiresAt: pending.expiresAt, userCode: pending.userCode, verificationUri: CODEX_DEVICE_VERIFICATION_URI }),
      close: async () => abort.abort(),
    };
    this.pending = pending;
    this.lastError = undefined;
    void this.pollDevice(pending);
    return pending.view();
  }

  async pollDevice(pending) {
    try {
      while (!pending.abort.signal.aborted && Date.now() < pending.expiresAt) {
        await delay(pending.intervalMs, pending.abort.signal);
        const response = await this.fetchImpl(CODEX_DEVICE_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
          signal: pending.abort.signal,
        });
        if (response.ok) {
          const json = await response.json();
          if (typeof json?.authorization_code !== 'string' || typeof json?.code_verifier !== 'string') throw new Error('OpenAI returned an invalid device authorization result');
          await this.finishAuthorizationCode(json.authorization_code, json.code_verifier, DEVICE_REDIRECT_URI);
          await this.finishPending();
          return;
        }
        const body = await response.text().catch(() => '');
        if (/slow_down/i.test(body)) pending.intervalMs += 1_000;
        if (response.status !== 403 && response.status !== 404 && !/authorization_pending|slow_down/i.test(body)) throw new Error(`OpenAI device authorization failed (${response.status})`);
      }
      if (!pending.abort.signal.aborted) await this.finishPending('Device-code login timed out. Start a new login to try again.');
    } catch (cause) {
      if (!pending.abort.signal.aborted) await this.finishPending(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async finishAuthorizationCode(code, verifier, redirectUri) {
    const token = await exchangeAuthorizationCode({ code, verifier, redirectUri, fetchImpl: this.fetchImpl });
    const { path } = this.source();
    await writeAuthDocument(path, codexAuthDocument(token));
    this.sources.delete(path); // fresh login replaces any stale in-memory reader
    this.lastError = undefined;
  }

  async disconnect() {
    const source = this.source();
    if (source.storage === 'codex') throw new Error('Shared Codex CLI credentials are owned by the Codex CLI. Sign out there, or switch to DSH-managed credentials before disconnecting.');
    if (source.storage === 'custom') throw new Error('A composition-owned custom authPath cannot be removed from Settings.');
    if (this.pending !== undefined) await this.finishPending();
    try {
      await unlink(source.path);
    } catch (cause) {
      if (/** @type {{code?: string}} */ (cause)?.code !== 'ENOENT') throw cause;
    }
    this.sources.delete(source.path);
    this.lastError = undefined;
    return this.status();
  }

  async dispose() {
    await this.finishPending();
  }

  requireWritableSource() {
    if (!this.source().writable) throw new Error('This composition pins a custom authPath. Remove it to let DSH run an interactive login.');
  }

  async finishPending(error) {
    const pending = this.pending;
    this.pending = undefined;
    if (error !== undefined) this.lastError = error;
    await pending?.close();
  }
}
