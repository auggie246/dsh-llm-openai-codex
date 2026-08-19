/**
 * ChatGPT subscription OAuth credentials for the Codex backend.
 *
 * The credential lives on disk in the Codex CLI's auth file (default
 * `~/.codex/auth.json`, or `$CODEX_HOME/auth.json`), written there by
 * `codex login` with `auth_mode: chatgpt`:
 *
 * ```json
 * {
 *   "auth_mode": "chatgpt",
 *   "OPENAI_API_KEY": null,
 *   "tokens": {
 *     "id_token": "<jwt>",
 *     "access_token": "<jwt>",
 *     "refresh_token": "<opaque>",
 *     "account_id": "<uuid>"
 *   },
 *   "last_refresh": "<iso-8601>"
 * }
 * ```
 *
 * pi's own OAuth store shape (`~/.pi/agent/auth.json` entries) is accepted
 * too: `{ "type": "oauth", "access": "<jwt>", "refresh": "<opaque>",
 * "expires": <epoch-ms> }`.
 *
 * Freshness comes from the access token's own JWT `exp` claim (the Codex CLI
 * file records no expiry), falling back to a pi-style `expires`. An expired
 * or nearly-expired token is refreshed against `auth.openai.com` with the
 * public Codex CLI OAuth client id — the same flow the CLI and pi run — and
 * the rotated pair is written back atomically so the Codex CLI keeps working
 * from the same file.
 *
 * Refresh tokens rotate. Two holders of the same file (this plugin and the
 * Codex CLI) can race: the loser holds a dead refresh token, so a rejected
 * refresh reloads the file once and retries with whatever is on disk now.
 *
 * Secrets never enter error messages, and the file is rewritten with owner
 * permissions only (0o600), as the Codex CLI writes it.
 *
 * @module dsh-llm-openai-codex/auth
 */
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LlmError } from '@deepseek-ai/dsh-llm';

/** OAuth endpoints and the public Codex CLI client id (as shipped by Codex CLI and pi-ai). */
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Failure codes thrown through this module, all `LlmError`s. */
export const MISSING_CREDENTIAL = 'MISSING_CREDENTIAL';
export const INVALID_CREDENTIAL = 'INVALID_CREDENTIAL';
export const AUTH_REFRESH_FAILED = 'AUTH_REFRESH_FAILED';
export const AUTH_EXPIRED = 'AUTH_EXPIRED';

const PKG = 'dsh-llm-openai-codex';

/** The default Codex CLI auth file: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
export function defaultCodexAuthPath(env = process.env) {
  const codexHome = env.CODEX_HOME;
  if (typeof codexHome === 'string' && codexHome.length > 0) return join(codexHome, 'auth.json');
  return join(homedir(), '.codex', 'auth.json');
}

/** Expand a leading `~` (or `~/…`) against the OS home directory. */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/**
 * Decode a JWT payload without verification. Verification is the server's
 * job; the claim is only read to schedule a refresh before expiry.
 * @param {string} token
 * @returns {Record<string, unknown> | undefined} the payload, or undefined for a non-JWT.
 */
export function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Extract the ChatGPT account id from an access token, where the Codex
 * backend also reads it (pi-ai re-derives this per request, so a stale
 * `account_id` on disk is cosmetic).
 * @param {string} accessToken
 * @returns {string | undefined}
 */
export function accountIdOf(accessToken) {
  const auth = decodeJwtPayload(accessToken)?.['https://api.openai.com/auth'];
  const id = auth && typeof auth === 'object' ? auth['chatgpt_account_id'] : undefined;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * One parsed credential: the tokens needed to authenticate and refresh, the
 * expiry of the access token in epoch ms (`Infinity` when the token carries
 * no decodable expiry and is trusted as-is), and the raw document to update
 * in place on write-back.
 * @typedef {object} CodexCredential
 * @property {'codex-cli' | 'pi'} shape - which on-disk document holds it.
 * @property {string} access - the current access token.
 * @property {string} refresh - the current refresh token.
 * @property {number} expiresAt - epoch ms after which `access` is stale.
 * @property {string | undefined} accountId - ChatGPT account id, when known.
 * @property {Record<string, unknown>} raw - the parsed document this credential came from.
 */

/**
 * Parse an auth document in either supported shape.
 * @param {unknown} parsed - the JSON document.
 * @param {string} path - the file it came from, for diagnostics.
 * @returns {CodexCredential}
 */
export function parseAuthDocument(parsed, path) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LlmError(`${PKG}: ${path} is not a Codex auth document (expected a JSON object); sign in with the Codex CLI (\`codex login\`)`, INVALID_CREDENTIAL);
  }
  const doc = /** @type {Record<string, unknown>} */ (parsed);

  // Codex CLI shape.
  if (doc.tokens !== undefined) {
    const tokens = doc.tokens;
    if (tokens === null || typeof tokens !== 'object') {
      throw new LlmError(`${PKG}: ${path} has a non-object "tokens" field; sign in again with \`codex login\``, INVALID_CREDENTIAL);
    }
    const t = /** @type {Record<string, unknown>} */ (tokens);
    if (typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string') {
      if (typeof doc.OPENAI_API_KEY === 'string' && doc.OPENAI_API_KEY.length > 0) {
        throw new LlmError(`${PKG}: ${path} holds an API-key login (auth_mode "${String(doc.auth_mode ?? 'apikey')}"), not the ChatGPT subscription this route serves — run \`codex login\` and choose "Sign in with ChatGPT", or use an api-key provider route for that key`, INVALID_CREDENTIAL);
      }
      throw new LlmError(`${PKG}: ${path} has no ChatGPT subscription tokens; sign in with the Codex CLI (\`codex login\`) and choose "Sign in with ChatGPT"`, MISSING_CREDENTIAL);
    }
    const access = t.access_token;
    return {
      shape: 'codex-cli',
      access,
      refresh: t.refresh_token,
      expiresAt: jwtExpiresAt(access) ?? Number.POSITIVE_INFINITY,
      accountId: typeof t.account_id === 'string' ? t.account_id : accountIdOf(access),
      raw: doc,
    };
  }

  // pi OAuth-entry shape.
  if (typeof doc.access === 'string' && typeof doc.refresh === 'string') {
    const expires = typeof doc.expires === 'number' && Number.isFinite(doc.expires) ? doc.expires : undefined;
    const accountId = typeof doc.accountId === 'string' ? doc.accountId : accountIdOf(doc.access);
    return {
      shape: 'pi',
      access: doc.access,
      refresh: doc.refresh,
      expiresAt: expires ?? jwtExpiresAt(doc.access) ?? Number.POSITIVE_INFINITY,
      accountId,
      raw: doc,
    };
  }

  throw new LlmError(`${PKG}: ${path} is neither a Codex CLI auth file (no "tokens") nor a pi OAuth entry (no "access"/"refresh"); sign in with the Codex CLI (\`codex login\`)`, MISSING_CREDENTIAL);
}

/** Access-token expiry from its JWT `exp` claim, in epoch ms. */
function jwtExpiresAt(token) {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
}

/**
 * Exchange a refresh token for a rotated token pair with the Codex CLI's
 * public OAuth client.
 * @param {string} refreshToken
 * @param {(input: any, init?: any) => Promise<any>} fetchImpl - injectable for tests.
 * @returns {Promise<{access: string, refresh: string, expiresInMs: number, idToken: string | undefined, accountId: string | undefined}>}
 */
export async function refreshTokenPair(refreshToken, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }),
    });
  } catch (error) {
    throw new LlmError(`${PKG}: Codex token refresh failed at the network layer (${error instanceof Error ? error.message : String(error)})`, AUTH_REFRESH_FAILED, { cause: error });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const invalidGrant = response.status === 400 || response.status === 401 || /invalid_grant/i.test(text);
    if (invalidGrant) {
      throw new LlmError(`${PKG}: the Codex refresh token was rejected (${response.status}) — it has expired or been rotated by another client; sign in again with \`codex login\``, AUTH_EXPIRED);
    }
    throw new LlmError(`${PKG}: Codex token refresh failed (${response.status})`, AUTH_REFRESH_FAILED);
  }
  const json = await response.json();
  if (typeof json?.access_token !== 'string' || typeof json?.refresh_token !== 'string' || typeof json?.expires_in !== 'number') {
    throw new LlmError(`${PKG}: Codex token refresh response was missing fields`, AUTH_REFRESH_FAILED);
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expiresInMs: json.expires_in * 1000,
    idToken: typeof json.id_token === 'string' ? json.id_token : undefined,
    accountId: accountIdOf(json.access_token),
  };
}

/**
 * Merge a refreshed pair back into the document its credential came from,
 * preserving every unrelated field (and inventing neither).
 * @param {CodexCredential} credential
 * @param {Awaited<ReturnType<typeof refreshTokenPair>>} pair
 * @param {Date} now
 * @returns {{document: Record<string, unknown>, credential: CodexCredential}}
 */
export function documentWithRefreshedTokens(credential, pair, now = new Date()) {
  if (credential.shape === 'codex-cli') {
    const tokens = /** @type {Record<string, unknown>} */ (credential.raw.tokens ?? {});
    const nextTokens = { ...tokens, access_token: pair.access, refresh_token: pair.refresh };
    if (pair.idToken !== undefined) nextTokens.id_token = pair.idToken;
    if (pair.accountId !== undefined) nextTokens.account_id = pair.accountId;
    const document = { ...credential.raw, tokens: nextTokens, last_refresh: now.toISOString() };
    return { document, credential: { ...credential, access: pair.access, refresh: pair.refresh, expiresAt: now.getTime() + pair.expiresInMs, accountId: pair.accountId ?? credential.accountId, raw: document } };
  }
  const document = { ...credential.raw, type: 'oauth', access: pair.access, refresh: pair.refresh, expires: now.getTime() + pair.expiresInMs };
  if (pair.accountId !== undefined) document.accountId = pair.accountId;
  return { document, credential: { ...credential, access: pair.access, refresh: pair.refresh, expiresAt: now.getTime() + pair.expiresInMs, accountId: pair.accountId ?? credential.accountId, raw: document } };
}

/**
 * An auth file on disk: loads the current credential, refreshes it when it
 * nears expiry (serialized, so concurrent streams share one refresh), and
 * persists the rotated pair atomically over the file it came from.
 */
export class CodexAuthFile {
  /**
   * @param {object} options
   * @param {string} options.path - absolute path of the auth file.
   * @param {number} [options.refreshMarginMs=60000] - refresh this long before `exp`.
   * @param {(input: any, init?: any) => Promise<any>} [options.fetchImpl] - fetch override for tests.
   * @param {() => number} [options.now] - clock override for tests (epoch ms).
   */
  constructor(options) {
    this.path = options.path;
    this.refreshMarginMs = options.refreshMarginMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    /** @type {{credential: CodexCredential, mtimeMs: number} | undefined} */
    this.state = undefined;
    /** @type {Promise<CodexCredential> | undefined} */
    this.inflight = undefined;
  }

  /** A usable access token, refreshing first when the cached one is near expiry. */
  async getAccessToken() {
    const credential = await this.current();
    return credential.access;
  }

  /**
   * The credential to authenticate with now: the cached one while fresh, the
   * disk's when another process rewrote the file, else one serialized refresh.
   * @returns {Promise<CodexCredential>}
   */
  async current() {
    const state = await this.ensureLoaded();
    if (state.credential.expiresAt - this.refreshMarginMs > this.now()) return state.credential;
    return this.refresh();
  }

  /** Load once, then only re-read after the file changed on disk. */
  async ensureLoaded() {
    const mtimeMs = await this.mtime();
    if (this.state !== undefined && this.state.mtimeMs === mtimeMs) return this.state;
    const text = await this.readText();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new LlmError(`${PKG}: ${this.path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); sign in again with \`codex login\``, INVALID_CREDENTIAL, { cause: error });
    }
    const credential = parseAuthDocument(parsed, this.path);
    this.state = { credential, mtimeMs };
    return this.state;
  }

  async mtime() {
    try {
      return (await stat(this.path)).mtimeMs;
    } catch (error) {
      if (/** @type {{code?: string}} */ (error)?.code === 'ENOENT') {
        throw new LlmError(`${PKG}: no Codex credentials at ${this.path}; sign in with the Codex CLI (\`codex login\`) — or set CODEX_HOME / the route's authPath to the file holding your ChatGPT subscription login`, MISSING_CREDENTIAL);
      }
      throw error;
    }
  }

  async readText() {
    try {
      return await readFile(this.path, 'utf8');
    } catch (error) {
      if (/** @type {{code?: string}} */ (error)?.code === 'ENOENT') {
        throw new LlmError(`${PKG}: no Codex credentials at ${this.path}; sign in with the Codex CLI (\`codex login\`) — or set CODEX_HOME / the route's authPath to the file holding your ChatGPT subscription login`, MISSING_CREDENTIAL);
      }
      throw error;
    }
  }

  /**
   * One refresh for every concurrent caller. A rejected refresh reloads the
   * file once and retries: another client may have rotated the pair in the
   * meantime, and the on-disk copy is the winner.
   * @returns {Promise<CodexCredential>}
   */
  refresh() {
    if (this.inflight === undefined) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  /** @returns {Promise<CodexCredential>} */
  async doRefresh() {
    const before = /** @type {CodexCredential} */ (this.state?.credential);
    try {
      const pair = await refreshTokenPair(before.refresh, this.fetchImpl);
      return await this.persist(before, pair);
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      // Retry once against whatever is on disk now when it differs.
      let latest;
      try {
        const mtimeMs = await this.mtime();
        latest = parseAuthDocument(JSON.parse(await this.readText()), this.path);
        this.state = { credential: latest, mtimeMs };
      } catch {
        throw error;
      }
      if (latest.refresh === before.refresh) throw error;
      const pair = await refreshTokenPair(latest.refresh, this.fetchImpl);
      return await this.persist(latest, pair);
    }
  }

  /**
   * Write the rotated pair back atomically (temp file + rename) with
   * owner-only permissions, then adopt it as the current credential.
   * @param {CodexCredential} credential
   * @param {Awaited<ReturnType<typeof refreshTokenPair>>} pair
   * @returns {Promise<CodexCredential>}
   */
  async persist(credential, pair) {
    const { document, credential: next } = documentWithRefreshedTokens(credential, pair, new Date(this.now()));
    const temp = join(dirname(this.path), `.auth.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temp, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
    try {
      await rename(temp, this.path);
    } catch (error) {
      // A failed rename must not leave the temp copy of the secret behind.
      await unlinkQuiet(temp);
      throw error;
    }
    const mtimeMs = await this.mtime();
    this.state = { credential: next, mtimeMs };
    return next;
  }
}

async function unlinkQuiet(path) {
  try {
    await unlink(path);
  } catch {
    // best effort
  }
}

/**
 * Create the credential source for one provider route.
 * @param {object} options
 * @param {string} options.path - auth file path (`~` expanded).
 * @param {number} [options.refreshMarginMs] - refresh this long before `exp`.
 * @param {(input: any, init?: any) => Promise<any>} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @returns {CodexAuthFile}
 */
export function createCodexAuth(options) {
  return new CodexAuthFile({ ...options, path: expandHome(options.path) });
}
