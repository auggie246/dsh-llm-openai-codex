/**
 * OpenAI Codex (ChatGPT subscription) provider route for the DeepSeek
 * Harness LLM seam.
 *
 * The existing pi-ai adapter (`@deepseek-ai/dsh-llm-pi-ai`) authenticates
 * provider routes with API keys alone — pi-ai's OAuth-backed providers have
 * no key to resolve, so its own validation refuses them. This plugin closes
 * exactly that gap for OpenAI's Codex backend: it reuses the pi-ai catalog's
 * `openai-codex` provider (endpoint `https://chatgpt.com/backend-api`,
 * `openai-codex-responses` wire protocol, current codex model list) and the
 * generic `PiAiAdapter` request machinery, and answers its per-request
 * credential with a ChatGPT OAuth access token loaded from either a
 * DSH-managed credential file or the Codex CLI's shared auth file, refreshing
 * it when it nears expiry. pi-ai derives the `Authorization`,
 * `chatgpt-account-id`, `originator`, and `OpenAI-Beta` headers from that
 * token, so the backend never sees anything but a normal Codex client.
 *
 * The paired Web card starts browser PKCE OAuth or a device-code fallback at
 * auth.openai.com. It exposes only secret-free connection status and never
 * serializes access or refresh tokens to the browser.
 *
 * ```yaml
 * - insert:
 *     - id: llm-openai-codex
 *       name: 'dsh-llm-openai-codex'
 *       # config:                  # every key optional; defaults shown
 *       #   route: openai-codex
 *       #   displayName: OpenAI Codex
 *       #   authPath: ~/.codex/auth.json
 *       #   refreshMarginMs: 60000
 *       #   streamIdleTimeoutMs: 300000
 *       #   reasoning: medium        # default effort for models that reason
 *       #   modelDiscovery: auto     # fetch the backend's live model manifest
 *       #   modelRefreshMs: 21600000 # re-fetch every 6 hours; 0 disables the timer
 *       #   modelOverrides: {}       # per-model corrections (name, contextWindow, ...)
 *       #   models: [gpt-5.4, gpt-5.4-mini]   # narrow the picker list
 *       #   retryPolicy: { mode: normal, maxRetries: 2 }
 * ```
 *
 * @module dsh-llm-openai-codex
 */
import { LlmError, RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import z from '@deepseek-ai/schemastery';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
// Namespace (not named) import: harness 0.1.2-rc.1 removed the
// `settingsNamespace` helper this package used to export, and an ESM named
// import of a missing export fails at module link time — hard enough to take
// the whole host row down. The namespace object always imports.
import * as dshSettings from '@deepseek-ai/dsh-settings';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { CodexOAuthController } from './oauth.js';
import { CodexAuthGateway } from './remote.js';
import { CodexModelRegistry, mergeCodexModels } from './models.js';

/** Route key the provider registers under when the composition says nothing. */
export const DEFAULT_ROUTE = 'openai-codex';
/** pi-ai catalog id backing this route whose catalog it serves. */
export const CATALOG_PROVIDER = 'openai-codex';
/** Codex request-image pixel budget required by PiAiAdapter profiles. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4_194_304;
/** Codex request-image encoded-byte budget required by PiAiAdapter profiles. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1_048_576;
/**
 * Route-owned default retry policy. The Codex backend answers some transient
 * failures — a blip on its edge, for example — with an empty response body,
 * and over HTTP/2 there is no status text either, so pi-ai can only raise
 * "Request failed". The adapter classifies that message as the catch-all
 * code "PI_AI_ERROR", which the harness's default retryable set excludes,
 * and pi-ai's own request retries are pinned to zero. Without this policy
 * one such response kills the turn instantly; with it, the runtime retries
 * twice (~0.5s, then ~1s) and the same request succeeds. Deliberate
 * non-retryables stay out: AUTH and INVALID_REQUEST name deterministic
 * failures where a retry only delays the real diagnosis.
 */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['PI_AI_ERROR', 'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
});

/** Route-owned cache of the last live model manifest, under the DSH home. */
export const DEFAULT_MODELS_CACHE_PATH = () => dshHomePath('cache', 'openai-codex-models.json');
/** How often the route re-fetches the backend's model manifest by default (6 hours). */
export const DEFAULT_MODEL_REFRESH_MS = 21_600_000;
/** Schema of one `modelOverrides` value; the dict key is the model id. */
export const ModelOverrideSchema = z.object({
  /** Picker display name. */
  name: z.string(),
  /** Context window in tokens. */
  contextWindow: z.number().min(1),
  /** Output cap in tokens. */
  maxTokens: z.number().min(1),
  /** Input modalities, e.g. [text] or [text, image]. */
  input: z.array(z.string()),
  /**
   * Selectable thinking levels: each key is a pi-ai level (off, minimal,
   * low, medium, high, xhigh, max), its value the wire spelling to send —
   * `false` marks the level unsupported, `true` sends the level's own name.
   * `false` instead of a dict declares a non-reasoning model.
   */
  reasoningEfforts: z.union([z.boolean(), z.dict(z.union([z.string(), z.boolean()]))]),
  /** pi-ai compat switches (e.g. supportsOpenAIGrammarTools). */
  compat: z.dict(z.union([z.boolean(), z.string(), z.number()])),
});

/** Plugin configuration; every key optional. */
export const Config = z.object({
  /** Provider route key the models register under: `<route>/<model>` in pickers. */
  route: z.string().default(DEFAULT_ROUTE),
  /** Display name for selectors and status labels. */
  displayName: z.string().default('OpenAI Codex'),
  /**
   * Optional composition-owned credential file. Supplying it pins this route
   * to that path and disables the Settings source selector; without it the
   * card chooses DSH-managed credentials or the shared Codex CLI file.
   */
  authPath: z.string(),
  /** Refresh the access token this many milliseconds before its expiry. */
  refreshMarginMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(60_000),
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
  /** Default reasoning effort for reasoning models (e.g. low, medium, high); omission keeps the backend default. */
  reasoning: z.string(),
  /**
   * Serve only these model ids. With model discovery on (the default), the
   * list filters the merged catalog + live manifest, so it may name a model
   * the installed catalog does not ship yet; an id nothing serves is warned
   * about and appears when the backend's model list includes it.
   */
  models: z.array(z.string()),
  /** Fetch the backend's live model manifest and merge it with the installed catalog. */
  modelDiscovery: z.union(['auto', 'off']).default('auto'),
  /** Re-fetch the manifest this often (ms); 0 keeps the startup + login + manual refreshes only. */
  modelRefreshMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_MODEL_REFRESH_MS),
  /** Where the last manifest persists; omission uses `<DSH home>/cache/openai-codex-models.json`. */
  modelCachePath: z.string(),
  /** Per-model-id corrections applied over the resolved list (catalog, cached, or discovered). */
  modelOverrides: z.dict(ModelOverrideSchema),
  /** Provider-owned retry policy; omission uses the harness's normal defaults. */
  retryPolicy: RetryPolicySchema,
  /** Initial credential source; DSH-managed avoids requiring a Codex CLI installation. */
  storage: z.union(['dsh', 'codex']).default('dsh'),
});

/**
 * Resolve the settings namespace id across harness versions. Through 0.1.1
 * `@deepseek-ai/dsh-settings` exported `settingsNamespace(value)` — a
 * pattern-checking identity — and `settings.register` accepted its result.
 * 0.1.2-rc.1 removed the helper and validates the namespace inside
 * `settings.register` itself. When the helper exists (0.1.1) it still runs so
 * an invalid name fails exactly as before; when it does not (0.1.2+) the
 * validated lowercase-hyphenated name passes through untouched.
 * @param {string} value
 * @returns {string}
 */
export function settingsNamespaceOf(value) {
  return typeof dshSettings.settingsNamespace === 'function' ? dshSettings.settingsNamespace(value) : value;
}

/** The settings namespace that makes this plugin's Web configuration card discoverable. */
export const SETTINGS_NS = settingsNamespaceOf('llm-openai-codex');
/** User-editable source preference; auth tokens themselves never live in settings.yaml. */
export const SettingsConfig = z.object({
  storage: z.union(['dsh', 'codex']).default('dsh'),
});

export const name = 'llm-openai-codex';
export const inject = ['llm', 'settings', 'typert'];

/**
 * Every method the harness's llm seam calls on a registered adapter without a
 * base-class default, per the `LlmAdapter` contract in `@deepseek-ai/dsh-llm`
 * (unchanged from 0.1.1 through 0.1.2-rc.1; 0.1.2's added
 * `imageRequestPricing` carries a default that `apply` restores for older
 * adapter builds).
 */
export const ADAPTER_CONTRACT = ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream'];

/**
 * Fail at registration — not at turn time — when the adapter behind this
 * plugin predates the harness's seam. A version drift between the harness and
 * `@deepseek-ai/dsh-llm-pi-ai` otherwise surfaces as an opaque
 * `registration.adapter.<method> is not a function` on the first ChatGPT turn.
 * @param {import('@deepseek-ai/dsh-llm').LlmAdapter} adapter
 */
export function assertAdapterContract(adapter) {
  const missing = ADAPTER_CONTRACT.filter((member) => typeof adapter[member] !== 'function');
  if (missing.length === 0) return;
  throw new LlmError(
    `${name}: the pi-ai adapter is missing ${missing.join(', ')}; the installed @deepseek-ai/dsh-llm-pi-ai does not match the harness's adapter contract — upgrade this plugin's @deepseek-ai dependencies to the harness's version line`,
    'ADAPTER_CONTRACT_MISMATCH',
  );
}

/**
 * The `PiAiAuthInjection` every pi-ai collection requires since dsh-llm-pi-ai
 * 0.1.1. This route authenticates entirely through the request-level `apiKey`
 * override (`resolveApiKey` answers the ChatGPT OAuth access token, and pi-ai
 * treats that as the highest-priority auth), so the collection's own store is
 * never consulted for the Codex route — these members exist to satisfy the
 * contract honestly: reads answer "nothing stored", and the one write path
 * refuses rather than discarding a credential the caller believes it saved.
 * @type {import('@deepseek-ai/dsh-llm-pi-ai').PiAiAdapterOptions['auth']}
 */
const AUTH_INJECTION = {
  credentials: {
    read: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    modify: (providerId) => Promise.reject(new LlmError(`${name}: provider "${providerId}" has no writable credential store; this route authenticates through the Codex OAuth controller, not pi-ai's collection store`, 'NO_CREDENTIAL_STORE')),
    delete: () => Promise.resolve(),
  },
  authContext: {
    env: (envName) => Promise.resolve(process.env[envName]),
    fileExists: async (path) => {
      const expanded = path.startsWith('~/') || path === '~' ? resolve(homedir(), path.slice(1).replace(/^\//, '')) : path;
      try {
        await access(expanded);
        return true;
      } catch {
        return false;
      }
    },
  },
};

/**
 * Build the one immutable profile this route serves, around the pi-ai
 * catalog's openai-codex provider. The key set intentionally matches the
 * `ResolvedPiAiProviderProfile` the PiAiAdapter reads.
 * @param {import('@deepseek-ai/schemastery').output<typeof Config> | Record<string, unknown>} config
 * @param {object} [options]
 * @param {() => Array<any>} [options.getModels] - live model-list accessor; when given, the
 *   served list is read at every picker read instead of the resolved static list.
 * @returns {{profiles: Map<string, any>, route: string, catalogModels: Array<any>, unknownModelIds: string[], customAuthPath: string | undefined, refreshMarginMs: number}}
 */
export function resolveRoute(config, { getModels } = {}) {
  const route = config.route ?? DEFAULT_ROUTE;
  const catalog = builtinProviders().find((provider) => provider.id === CATALOG_PROVIDER);
  if (catalog === undefined) {
    throw new LlmError(`${name}: the installed @earendil-works/pi-ai ships no "${CATALOG_PROVIDER}" catalog provider; upgrade pi-ai to 0.82.1 or newer`, 'NO_CATALOG');
  }

  const displayName = config.displayName ?? 'OpenAI Codex';
  const catalogModels = catalog.getModels();
  // `models` filters the served list rather than restating it, and a named id
  // nothing serves is a warning, not a throw: with model discovery on, an id
  // can be valid before the installed catalog knows it — it arrives with the
  // backend's manifest. Without discovery the warning still fires, from apply.
  // `modelOverrides` applies here too, so metadata corrections hold with
  // discovery off exactly as they hold over discovered models.
  const filter = Array.isArray(config.models) && config.models.length > 0 ? new Set(config.models) : undefined;
  const merged = mergeCodexModels({ catalogModels, manifestEntries: [], overrides: config.modelOverrides ?? {}, filter });
  const models = merged.models;
  const unknownModelIds = merged.unknownFilterIds;
  // The pi-ai Provider owns API implementations this package cannot rebuild
  // (the codex API module is lazy-loaded by the catalog factory), so reuse
  // the catalog provider's dispatch verbatim and substitute only identity
  // and catalog — the pattern dsh-llm-pi-ai's reuseCatalogProvider follows.
  // One addition matters: pi-ai honors a request's apiKey override only when
  // the provider declares an api-key auth method, and the OAuth-only
  // openai-codex catalog provider declares none, so without this the request
  // fails with "Provider is not configured" before the wire is touched. The
  // added method passes the harness-resolved credential — our OAuth access
  // token — straight through.
  const piProvider = {
    id: route,
    name: displayName,
    ...(catalog.baseUrl === undefined ? {} : { baseUrl: catalog.baseUrl }),
    auth: {
      ...catalog.auth,
      apiKey: {
        name: displayName,
        resolve: ({ credential }) =>
          Promise.resolve({
            auth: credential?.key === undefined ? {} : { apiKey: credential.key },
            source: displayName,
          }),
      },
    },
    getModels: () => (getModels !== undefined ? getModels() : models),
    stream: (model, context, options) => catalog.stream(model, context, options),
    streamSimple: (model, context, options) => catalog.streamSimple(model, context, options),
  };

  const profile = {
    provider: route,
    displayName,
    piProvider,
    // An unconfigured route takes DEFAULT_RETRY_POLICY (see its rationale);
    // an explicit config.retryPolicy replaces it verbatim via resolveRetryPolicy.
    retryPolicy: resolveRetryPolicy(config.retryPolicy ?? DEFAULT_RETRY_POLICY, `${name}: config.retryPolicy`),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 300_000,
    // PiAiAdapter forwards these fields to AttachmentStore.readImageRequest().
    // Unlike its settings-backed profiles, this plugin builds the profile
    // directly, so its defaults must be present here.
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    configuredMaxTokens: new Map(),
    ...(config.reasoning === undefined ? {} : { reasoning: config.reasoning }),
  };
  return {
    profiles: new Map([[route, profile]]),
    route,
    catalogModels,
    unknownModelIds,
    // A composition-owned path is intentionally an escape hatch for managed
    // deployments; when absent the Settings card selects DSH-managed vs the
    // shared Codex CLI file at runtime.
    customAuthPath: config.authPath,
    refreshMarginMs: config.refreshMarginMs ?? 60_000,
  };
}

/**
 * Register the openai-codex route: one PiAiAdapter whose per-request
 * credential is the ChatGPT access token from the Codex auth file, serving a
 * model list that tracks the account through live Codex model discovery.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/schemastery').output<typeof Config>} config
 */
export function apply(ctx, config) {
  const resolved = resolveRoute(config ?? {}, {
    // With discovery on, the served list is the registry's live array — read
    // at every picker read, descriptor lookup, and request, so an adopt
    // reaches the next operation without a restart. With discovery off, the
    // accessor is omitted and resolveRoute's static list serves.
    getModels: (config?.modelDiscovery ?? 'auto') === 'off' ? undefined : () => registry.models,
  });
  const source = ctx.settings.register(SETTINGS_NS, SettingsConfig, {
    base: { storage: config?.storage ?? 'dsh' },
  });
  let preference = source.get();
  ctx.effect(() => source.watch((next) => {
    preference = next;
  }), `${name}: credential-source preference`);

  // Live model discovery. The registry owns the served list; the profile's
  // getModels accessor reads it at every picker read, descriptor lookup, and
  // request, so an adopt reaches the next operation without a restart. With
  // discovery off, the accessor is absent and the static resolved list serves.
  const discoveryEnabled = (config?.modelDiscovery ?? 'auto') !== 'off';
  const modelFilter = Array.isArray(config?.models) && config.models.length > 0 ? new Set(config.models) : undefined;
  const registry = new CodexModelRegistry({
    catalogModels: resolved.catalogModels,
    filter: modelFilter,
    overrides: config?.modelOverrides ?? {},
    cachePath: config?.modelCachePath ?? DEFAULT_MODELS_CACHE_PATH(),
    getAccessToken: () => auth.getAccessToken(),
    getAccountId: async () => (await auth.authFile().current()).accountId,
    onWarn: (detail) => ctx.logger.warn(`${name}: ${detail}`),
  });
  if (resolved.unknownModelIds.length > 0 && !discoveryEnabled) {
    ctx.logger.warn(`${name}: config.models names ${resolved.unknownModelIds.map((id) => JSON.stringify(id)).join(', ')}, which the ${CATALOG_PROVIDER} catalog does not ship; enable model discovery (default) or remove ${resolved.unknownModelIds.length === 1 ? 'that id' : 'those ids'}`);
  }

  /** Re-announce the adapter after the served model set changes, so open model pickers re-read without a reload. */
  const notifyModelsChanged = () => {
    try {
      ctx.llm.emitAdaptersUpdated?.();
    } catch (cause) {
      ctx.logger.warn(`${name}: announcing refreshed models failed (${cause instanceof Error ? cause.message : String(cause)})`);
    }
  };

  const auth = new CodexOAuthController({
    storage: () => preference.storage,
    setStorage: (storage) => source.update({ storage }),
    customAuthPath: resolved.customAuthPath,
    refreshMarginMs: resolved.refreshMarginMs,
    registry,
    // A login or a source switch can mean a different ChatGPT account whose
    // manifest answers differently; discovery re-runs in the background.
    onCredentialChange: discoveryEnabled ? () => {
      void registry.refresh().then((status) => {
        if (status?.changed) notifyModelsChanged();
      });
    } : undefined,
  });
  // The Typert loader discovers this package's host manifest; the gateway
  // supplies its implementations under the matching codexAuth service key.
  // `typert` is a hard injected dependency in the host composition. The guard
  // keeps this module's lightweight adapter tests independent of a full
  // Cordis gateway fixture; a real mount never reaches this branch absent.
  if (ctx.typert !== undefined) new CodexAuthGateway(ctx, auth, { onModelsChanged: notifyModelsChanged });
  ctx.effect(() => () => auth.dispose(), `${name}: OAuth login cleanup`);

  if (discoveryEnabled) {
    // Startup: adopt the persisted manifest first (instant, offline), then
    // refresh against the backend when credentials allow.
    void registry.loadCache().then(() => registry.refresh()).catch(() => {});
    if ((config?.modelRefreshMs ?? DEFAULT_MODEL_REFRESH_MS) > 0) {
      ctx.effect(() => {
        const timer = setInterval(() => {
          void registry.refresh().then((status) => {
            if (status?.changed) notifyModelsChanged();
          });
        }, config?.modelRefreshMs ?? DEFAULT_MODEL_REFRESH_MS);
        return () => clearInterval(timer);
      }, `${name}: model discovery refresh`);
    }
  }

  const adapter = new PiAiAdapter({
    profiles: () => resolved.profiles,
    resolveApiKey: () => auth.getAccessToken(),
    auth: AUTH_INJECTION,
    resolveAttachments: () => ctx.get('attachments'),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`${name}: unusable replay state on assistant history for route "${provider}/${model}"; sending that message as provider-neutral content (${reason})`);
    },
  });
  assertAdapterContract(adapter);
  // Harness 0.1.2 asks every registered adapter for per-model image pricing
  // (`LlmAdapter.imageRequestPricing`, default "none") and calls it unguarded
  // from the token meter. The method ships with the 0.1.2 adapter base class,
  // so an adapter built against 0.1.1 — still installable while this package's
  // peer range admits both trains — lacks it and every priced request would
  // die with `adapter.imageRequestPricing is not a function`. Attaching the
  // same "route declares no pricing" answer the 0.1.2 base class provides
  // keeps a mixed-version tree serving turns. On a 0.1.2 adapter this branch
  // never runs, and on 0.1.1 nothing ever calls the added member.
  if (typeof adapter.imageRequestPricing !== 'function') {
    adapter.imageRequestPricing = () => undefined;
  }
  ctx.llm.registerAdapter([resolved.route], adapter);
  ctx.logger.info(`${name}: provider route "${resolved.route}" serving ${resolved.profiles.get(resolved.route).piProvider.getModels().length} model(s) (${discoveryEnabled ? 'catalog + live Codex model discovery' : 'static Codex catalog'}); credential source ${auth.source().label}`);
}
