/**
 * Live Codex model discovery for the openai-codex route.
 *
 * The pi-ai catalog (`builtinProviders().openai-codex`) is a static,
 * generated file: a model OpenAI ships after that file was built does not
 * exist for this route until pi-ai publishes a new catalog, the dependency
 * range admits it, and the deployment upgrades. The Codex backend itself has
 * no such lag — the same ChatGPT OAuth token the route already holds answers
 * a live models manifest:
 *
 * ```
 * GET https://chatgpt.com/backend-api/codex/models?client_version=<v>
 * Authorization: Bearer <access token>
 * ```
 *
 * (The endpoint the Codex CLI and ChatGPT web both consult; the Codex CLI
 * caches its answer in `~/.codex/models_cache.json`.) This module fetches
 * that manifest, merges it with the installed catalog, and hands the route a
 * picker list that tracks the account:
 *
 * - A slug the catalog knows keeps its catalog entry — costs, context
 *   window, thinking levels, and compat stay the hand-audited values.
 * - A slug the catalog lacks is synthesized: identity and sizes from the
 *   manifest, wire protocol and compat from its closest catalog sibling,
 *   reasoning levels from the manifest's own effort list.
 * - A catalog model the manifest explicitly hides for this account
 *   (`visibility: hide`) leaves the picker.
 * - `modelOverrides` from the composition corrects any of it per model id.
 *
 * Every failure keeps the previous list: an unreachable backend, a rejected
 * token, a malformed manifest — the picker degrades to the installed
 * catalog, never to empty.
 *
 * @module dsh-llm-openai-codex/models
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { INVALID_CREDENTIAL, MISSING_CREDENTIAL } from './auth.js';

/** The Codex backend models manifest endpoint (same host as turns). */
export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
/**
 * The `client_version` the manifest request reports. The backend may gate a
 * model behind a minimum client version; this matches what the Codex CLI
 * sends today. A model gated behind a version newer than this constant stays
 * hidden until the constant moves — deliberate, because a model the protocol
 * layer cannot serve yet must not advertise itself.
 */
export const MODELS_CLIENT_VERSION = '1.0.0';
/** Failure code for every discovery failure. All are `LlmError`s. */
export const MODEL_FETCH_FAILED = 'MODEL_FETCH_FAILED';

const PKG = 'dsh-llm-openai-codex';
/** The one wire protocol every catalog model on this route speaks. */
const WIRE_API = 'openai-codex-responses';
/** pi-ai's catalog provider id; request dispatch matches on it. */
const CATALOG_PROVIDER = 'openai-codex';
/** pi-ai's thinking levels, in escalation order. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Sizes for a synthesized model whose manifest entry discloses neither. */
const FALLBACK_CONTEXT_WINDOW = 272_000;
const FALLBACK_MAX_TOKENS = 128_000;

function message(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Fetch the account's models manifest. Headers carry the access token and,
 * when known, the ChatGPT account id; the response body never enters an
 * error message, so a failure cannot leak account state into logs or cards.
 * @param {object} options
 * @param {string} options.accessToken - a current ChatGPT OAuth access token.
 * @param {string | undefined} options.accountId - ChatGPT account id, when known.
 * @param {string} [options.clientVersion] - reported client version.
 * @param {(input: any, init?: any) => Promise<any>} [options.fetchImpl]
 * @returns {Promise<Array<Record<string, unknown>>>} manifest entries, ordered by the backend's priority then slug.
 */
export async function fetchCodexModelManifest({ accessToken, accountId, clientVersion = MODELS_CLIENT_VERSION, fetchImpl = fetch } = {}) {
  const url = new URL(CODEX_MODELS_URL);
  url.searchParams.set('client_version', clientVersion);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(accountId === undefined ? {} : { 'ChatGPT-Account-Id': accountId }),
      },
    });
  } catch (cause) {
    throw new LlmError(`${PKG}: Codex model discovery failed at the network layer (${message(cause)})`, MODEL_FETCH_FAILED, { cause });
  }
  if (!response.ok) {
    throw new LlmError(`${PKG}: Codex model discovery failed (${response.status})`, MODEL_FETCH_FAILED);
  }
  let json;
  try {
    json = await response.json();
  } catch (cause) {
    throw new LlmError(`${PKG}: Codex model discovery returned a body no JSON parser accepts (${message(cause)})`, MODEL_FETCH_FAILED, { cause });
  }
  const entries = json !== null && typeof json === 'object' ? json.models : undefined;
  if (!Array.isArray(entries)) {
    throw new LlmError(`${PKG}: Codex model discovery returned no model list`, MODEL_FETCH_FAILED);
  }
  const models = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.slug !== 'string' || entry.slug.length === 0) continue;
    models.push(entry);
  }
  const priority = (entry) => (typeof entry.priority === 'number' && Number.isFinite(entry.priority) ? entry.priority : 10_000);
  models.sort((a, b) => priority(a) - priority(b) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return models;
}

/** Manifest visibility that removes a model from the account's picker. */
function isHidden(entry) {
  const visibility = typeof entry.visibility === 'string' ? entry.visibility.trim().toLowerCase() : '';
  return visibility === 'hide' || visibility === 'hidden';
}

/** The wire efforts a manifest entry declares, lowercased and de-duplicated. */
function effortsOf(entry) {
  const levels = entry.supported_reasoning_levels;
  if (!Array.isArray(levels)) return [];
  const efforts = [];
  for (const level of levels) {
    const effort = level !== null && typeof level === 'object' ? level.effort : level;
    if (typeof effort !== 'string') continue;
    const normalized = effort.trim().toLowerCase();
    if (normalized.length > 0 && !efforts.includes(normalized)) efforts.push(normalized);
  }
  return efforts;
}

/**
 * pi-ai's `thinkingLevelMap` for one manifest effort list. Keys are pi-ai
 * levels; values are the wire spellings dispatch sends. Every level is
 * decided explicitly — supported levels map to their wire name, unsupported
 * ones pin to `null` — because pi-ai's own defaulting is asymmetric and a
 * live manifest is exactly where an unlisted level would silently pass.
 * `off` stays absent: selecting it omits the reasoning parameter, which is
 * what "no effort" means to this backend. `minimal` falls back to `low`,
 * the same wire shape the installed catalog ships.
 * @param {string[]} efforts - lowercased wire efforts the model accepts.
 * @returns {Record<string, string | null>}
 */
export function thinkingLevelMapFor(efforts) {
  const has = (effort) => efforts.includes(effort);
  /** @type {Record<string, string | null>} */
  const map = {};
  if (has('minimal')) map.minimal = 'minimal';
  else if (has('low')) map.minimal = 'low';
  else map.minimal = null;
  for (const level of ['low', 'medium', 'high']) map[level] = has(level) ? level : null;
  map.xhigh = has('xhigh') ? 'xhigh' : null;
  map.max = has('max') ? 'max' : null;
  return map;
}

/**
 * The installed catalog sibling sharing the longest leading run of hyphen
 * segments with `slug` — for a hypothetical `gpt-5.7-mini` that is
 * `gpt-5.6-mini` before `gpt-5.6`. A tie (a brand-new family shares only its
 * root with everything) prefers an image-capable sibling, then the larger
 * context window: the picker default should not inherit a niche catalog
 * entry's narrower modalities when every mainstream sibling takes images.
 * @param {string} slug
 * @param {Array<any>} catalogModels
 */
function closestSibling(slug, catalogModels) {
  const segments = slug.split('-');
  let bestShared = -1;
  let candidates = [];
  for (const model of catalogModels) {
    const candidate = model.id.split('-');
    let shared = 0;
    while (shared < segments.length && shared < candidate.length && segments[shared] === candidate[shared]) shared += 1;
    if (shared > bestShared) {
      bestShared = shared;
      candidates = [model];
    } else if (shared === bestShared) {
      candidates.push(model);
    }
  }
  const imageCapable = candidates.filter((model) => Array.isArray(model.input) && model.input.includes('image'));
  if (imageCapable.length > 0) candidates = imageCapable;
  return candidates.reduce((best, model) => ((model.contextWindow ?? 0) > (best.contextWindow ?? 0) ? model : best), candidates[0]);
}

/**
 * Build the pi-ai model a catalog-less manifest slug serves. Identity and
 * sizes come from the manifest; protocol, compat, and modalities come from
 * the closest catalog sibling, on the reasoning that a brand-new sibling of
 * an existing family speaks like its family. Every guessed field is
 * correctable per model through `modelOverrides` without a plugin upgrade.
 * @param {Record<string, unknown>} entry - one manifest entry.
 * @param {Array<any>} catalogModels - the installed catalog, for sibling traits.
 * @returns {object} a pi-ai Model for the openai-codex-responses wire.
 */
export function synthesizeCodexModel(entry, catalogModels) {
  const slug = /** @type {string} */ (entry.slug);
  const sibling = closestSibling(slug, catalogModels);
  const efforts = effortsOf(entry);
  const contextWindow = typeof entry.context_window === 'number' && Number.isFinite(entry.context_window) && entry.context_window > 0
    ? entry.context_window
    : FALLBACK_CONTEXT_WINDOW;
  const maxTokens = typeof entry.max_output_tokens === 'number' && Number.isFinite(entry.max_output_tokens) && entry.max_output_tokens > 0
    ? entry.max_output_tokens
    : Math.min(FALLBACK_MAX_TOKENS, contextWindow);
  return {
    id: slug,
    name: typeof entry.display_name === 'string' && entry.display_name.length > 0 ? entry.display_name : slug,
    api: WIRE_API,
    provider: CATALOG_PROVIDER,
    ...(sibling?.baseUrl === undefined ? {} : { baseUrl: sibling.baseUrl }),
    reasoning: efforts.length > 0,
    ...(efforts.length > 0 ? { thinkingLevelMap: thinkingLevelMapFor(efforts) } : {}),
    input: sibling?.input ?? ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(sibling?.compat === undefined ? {} : { compat: { ...sibling.compat } }),
  };
}

/**
 * Apply one `modelOverrides` entry onto a resolved model. Only fields the
 * entry declares change; everything else keeps its resolved value. An entry
 * the schema let through but whose shape this function cannot honor (an
 * empty `reasoningEfforts` dict, a non-positive size) is ignored rather than
 * fatal: a bad override must degrade one model's description, never the
 * route.
 * @param {any} model - the resolved pi-ai model.
 * @param {any} override - the composition's override entry, when present.
 * @returns {any} the corrected model (a new object when anything changed).
 */
export function applyModelOverride(model, override) {
  if (override === undefined || override === null || typeof override !== 'object') return model;
  const next = { ...model };
  if (typeof override.name === 'string' && override.name.length > 0) next.name = override.name;
  if (typeof override.contextWindow === 'number' && Number.isFinite(override.contextWindow) && override.contextWindow > 0) next.contextWindow = override.contextWindow;
  if (typeof override.maxTokens === 'number' && Number.isFinite(override.maxTokens) && override.maxTokens > 0) next.maxTokens = override.maxTokens;
  if (Array.isArray(override.input) && override.input.length > 0 && override.input.every((modality) => typeof modality === 'string')) {
    next.input = [...override.input];
  }
  if (override.compat !== undefined && override.compat !== null && typeof override.compat === 'object' && !Array.isArray(override.compat)) {
    next.compat = { ...model.compat, ...override.compat };
  }
  if (override.reasoningEfforts === false) {
    next.reasoning = false;
    delete next.thinkingLevelMap;
  } else if (override.reasoningEfforts !== undefined && override.reasoningEfforts !== null && typeof override.reasoningEfforts === 'object' && !Array.isArray(override.reasoningEfforts)) {
    const declared = Object.entries(override.reasoningEfforts).filter(([level]) => THINKING_LEVELS.includes(level));
    const thinking = declared.some(([level]) => level !== 'off');
    if (thinking) {
      /** @type {Record<string, string | null>} */
      const map = {};
      for (const level of THINKING_LEVELS) {
        const value = override.reasoningEfforts[level];
        if (level === 'off') {
          // `off` declared with a value sends that value; left out or null it
          // stays absent from the map — "supported, send nothing".
          if (typeof value === 'string' && value.length > 0) map.off = value;
          continue;
        }
        map[level] = typeof value === 'string' && value.length > 0 ? value : null;
      }
      next.reasoning = true;
      next.thinkingLevelMap = map;
    }
  }
  return next;
}

/**
 * Merge the manifest with the installed catalog into the picker list.
 *
 * Manifest order (backend priority, then slug) wins for discovered models;
 * catalog models the manifest never mentions survive at the end, because a
 * partial or older manifest must not remove a model the installed catalog
 * still serves — only an explicit per-account hide does. The composition's
 * `models` filter, when set, keeps the intersection; ids it names that
 * nothing served are the caller's warning, not a throw, because with live
 * discovery an id can be valid now and known a refresh later.
 * @param {object} options
 * @param {Array<any>} options.catalogModels - installed pi-ai catalog entries.
 * @param {Array<Record<string, unknown>>} options.manifestEntries - manifest entries (may be empty).
 * @param {Record<string, any>} [options.overrides] - per-model-id corrections.
 * @param {Set<string> | undefined} [options.filter] - the composition's `models` allowlist.
 * @returns {{models: Array<any>, unknownFilterIds: string[]}}
 */
export function mergeCodexModels({ catalogModels, manifestEntries, overrides = {}, filter } = {}) {
  const catalogById = new Map(catalogModels.map((model) => [model.id, model]));
  const hidden = new Set(manifestEntries.filter(isHidden).map((entry) => /** @type {string} */ (entry.slug)));
  const models = [];
  const seen = new Set();
  for (const entry of manifestEntries) {
    if (isHidden(entry)) continue;
    const slug = /** @type {string} */ (entry.slug);
    seen.add(slug);
    const base = catalogById.get(slug) ?? synthesizeCodexModel(entry, catalogModels);
    models.push(applyModelOverride(base, overrides[slug]));
  }
  for (const model of catalogModels) {
    if (seen.has(model.id) || hidden.has(model.id)) continue;
    models.push(applyModelOverride(model, overrides[model.id]));
  }
  const filtered = filter === undefined ? models : models.filter((model) => filter.has(model.id));
  const unknownFilterIds = filter === undefined
    ? []
    : [...filter].filter((id) => !filtered.some((model) => model.id === id));
  return { models: filtered, unknownFilterIds };
}

/** A persisted discovery answer: raw manifest entries plus when they arrived. */
async function writeCache(path, { entries, fetchedAt, clientVersion }) {
  const document = { clientVersion, fetchedAt, models: entries };
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temp = join(parent, `.openai-codex-models.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(temp, JSON.stringify(document, null, 2) + '\n');
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Owns the route's current model list. `models` returns the array the
 * route's `piProvider.getModels()` closure serves; the PiAiAdapter reads
 * that closure on every operation, so a refresh reaches the next picker
 * read, descriptor lookup, and request without a restart or a new profile
 * identity. Fetch, merge, cache, and error state stay behind `refresh` and
 * `snapshot`.
 */
export class CodexModelRegistry {
  /**
   * @param {object} options
   * @param {Array<any>} options.catalogModels - the installed pi-ai catalog (unfiltered).
   * @param {Set<string> | undefined} options.filter - the composition's `models` allowlist, when set.
   * @param {Record<string, any>} [options.overrides] - per-model corrections.
   * @param {string} options.cachePath - where the last manifest persists.
   * @param {() => Promise<string>} options.getAccessToken - current ChatGPT access token.
   * @param {() => Promise<string | undefined>} options.getAccountId - ChatGPT account id, when known.
   * @param {string} [options.clientVersion] - manifest client version.
   * @param {(input: any, init?: any) => Promise<any>} [options.fetchImpl]
   * @param {() => number} [options.now] - clock override for tests (epoch ms).
   * @param {(detail: string) => void} [options.onWarn] - failure reporter (secret-free).
   */
  constructor(options) {
    this.catalogModels = options.catalogModels;
    this.filter = options.filter;
    this.overrides = options.overrides ?? {};
    this.cachePath = options.cachePath;
    this.getAccessToken = options.getAccessToken;
    this.getAccountId = options.getAccountId;
    this.clientVersion = options.clientVersion ?? MODELS_CLIENT_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.onWarn = options.onWarn ?? (() => {});
    /** @type {Array<any>} */
    this.models = mergeCodexModels({ catalogModels: options.catalogModels, manifestEntries: [], overrides: this.overrides, filter: options.filter }).models;
    /** @type {'catalog' | 'cache' | 'manifest'} */
    this.source = 'catalog';
    /** @type {number | null} */
    this.fetchedAt = null;
    /** @type {string | null} */
    this.error = null;
    /** @type {Promise<object> | undefined} */
    this.inflight = undefined;
  }

  /** Secret-free discovery state for the Settings card and logs. */
  snapshot() {
    return { count: this.models.length, source: this.source, fetchedAt: this.fetchedAt, error: this.error };
  }

  /**
   * Adopt the persisted manifest, if one is readable. A missing cache is the
   * normal first run; a corrupt one is a warning, and the catalog serves.
   * @returns {Promise<boolean>} whether the served list changed.
   */
  async loadCache() {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.cachePath, 'utf8'));
    } catch (cause) {
      if (/** @type {{code?: string}} */ (cause)?.code !== 'ENOENT') {
        this.onWarn(`the discovered-model cache could not be read (${message(cause)}); serving the installed catalog until the next discovery succeeds`);
      }
      return false;
    }
    const entries = raw !== null && typeof raw === 'object' && Array.isArray(raw.models) ? raw.models : null;
    if (entries === null) {
      this.onWarn('the discovered-model cache holds no model list; serving the installed catalog until the next discovery succeeds');
      return false;
    }
    return this.adopt({
      entries,
      fetchedAt: typeof raw.fetchedAt === 'number' && Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : null,
      source: 'cache',
    });
  }

  /**
   * Swap the served list for a fresh merge. Returns whether any picker
   * reading the old list would now see a different id set.
   * @param {object} parts
   * @param {Array<Record<string, unknown>>} parts.entries
   * @param {number | null} parts.fetchedAt
   * @param {'cache' | 'manifest'} parts.source
   * @returns {boolean}
   */
  adopt({ entries, fetchedAt, source }) {
    const before = this.models.map((model) => model.id).join('\n');
    const { models, unknownFilterIds } = mergeCodexModels({ catalogModels: this.catalogModels, manifestEntries: entries, overrides: this.overrides, filter: this.filter });
    this.models = models;
    this.source = source;
    this.fetchedAt = fetchedAt;
    this.error = null;
    if (unknownFilterIds.length > 0) {
      this.onWarn(`config.models names ${unknownFilterIds.map((id) => JSON.stringify(id)).join(', ')}; no catalog model or discovered Codex model serves ${unknownFilterIds.length === 1 ? 'that id' : 'those ids'} yet — it appears when the backend's model list includes it`);
    }
    return this.models.map((model) => model.id).join('\n') !== before;
  }

  /**
   * One discovery for every concurrent caller: a token refresh, a Settings
   * click, and the periodic timer share this promise. A missing or invalid
   * credential is the not-signed-in state, not a failure — the catalog
   * serves and no warning fires.
   * @returns {Promise<object>} the post-refresh snapshot plus `changed`.
   */
  refresh() {
    if (this.inflight === undefined) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  /** @returns {Promise<object>} */
  async doRefresh() {
    try {
      const accessToken = await this.getAccessToken();
      const accountId = await this.getAccountId();
      const entries = await fetchCodexModelManifest({ accessToken, accountId, clientVersion: this.clientVersion, fetchImpl: this.fetchImpl });
      const changed = this.adopt({ entries, fetchedAt: this.now(), source: 'manifest' });
      try {
        await writeCache(this.cachePath, { entries, fetchedAt: this.fetchedAt ?? this.now(), clientVersion: this.clientVersion });
      } catch (cause) {
        this.onWarn(`the discovered-model cache could not be written (${message(cause)}); discovery still serves this process`);
      }
      return { ...this.snapshot(), changed };
    } catch (cause) {
      if (cause instanceof LlmError && (cause.code === MISSING_CREDENTIAL || cause.code === INVALID_CREDENTIAL)) {
        // Not signed in yet: the installed catalog serves, and the Settings
        // card already says "Not connected". This is routine, not an alarm.
        return { ...this.snapshot(), changed: false };
      }
      this.error = message(cause);
      this.onWarn(this.error);
      return { ...this.snapshot(), changed: false };
    }
  }
}
