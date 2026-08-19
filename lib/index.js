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
 * credential with a ChatGPT OAuth access token loaded from the Codex CLI's
 * auth file, refreshing it when it nears expiry. pi-ai derives the
 * `Authorization`, `chatgpt-account-id`, `originator`, and `OpenAI-Beta`
 * headers from that token, so the backend never sees anything but a normal
 * Codex client.
 *
 * Sign-in is the Codex CLI's (`codex login`, "Sign in with ChatGPT"); this
 * plugin runs no login flow of its own.
 *
 * ```yaml
 * - insert:
 *     - id: llm-openai-codex
 *       name: 'dsh-llm-openai-codex'
 *       # config:            # every key optional; defaults shown
 *       #   route: openai-codex
 *       #   displayName: OpenAI Codex
 *       #   authPath: ~/.codex/auth.json
 *       #   refreshMarginMs: 60000
 *       #   streamIdleTimeoutMs: 300000
 *       #   reasoning: medium        # default effort for models that reason
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
import { createCodexAuth, defaultCodexAuthPath } from './auth.js';

/** Route key the provider registers under when the composition says nothing. */
export const DEFAULT_ROUTE = 'openai-codex';
/** pi-ai catalog id backing this route whose catalog it serves. */
export const CATALOG_PROVIDER = 'openai-codex';

/** Plugin configuration; every key optional. */
export const Config = z.object({
  /** Provider route key the models register under: `<route>/<model>` in pickers. */
  route: z.string().default(DEFAULT_ROUTE),
  /** Display name for selectors and status labels. */
  displayName: z.string().default('OpenAI Codex'),
  /**
   * Codex OAuth credential file. Reads the Codex CLI's `auth.json` (also
   * accepts a pi OAuth entry); `$CODEX_HOME/auth.json` is the default when
   * CODEX_HOME is set, else `~/.codex/auth.json`. Refreshed tokens write back
   * over this file atomically.
   */
  authPath: z.string(),
  /** Refresh the access token this many milliseconds before its expiry. */
  refreshMarginMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(60_000),
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
  /** Default reasoning effort for reasoning models (e.g. low, medium, high); omission keeps the backend default. */
  reasoning: z.string(),
  /** Narrow the served catalog to these model ids; omission serves every codex model pi-ai ships. */
  models: z.array(z.string()),
  /** Provider-owned retry policy; omission uses the harness's normal defaults. */
  retryPolicy: RetryPolicySchema,
});

export const name = 'llm-openai-codex';
export const inject = ['llm'];

/**
 * Build the one immutable profile this route serves, around the pi-ai
 * catalog's openai-codex provider. The key set intentionally matches the
 * `ResolvedPiAiProviderProfile` the PiAiAdapter reads.
 * @param {import('@deepseek-ai/schemastery').output<typeof Config> | Record<string, unknown>} config
 * @returns {{profiles: Map<string, any>, route: string, authPath: string, refreshMarginMs: number}}
 */
export function resolveRoute(config) {
  const route = config.route ?? DEFAULT_ROUTE;
  const catalog = builtinProviders().find((provider) => provider.id === CATALOG_PROVIDER);
  if (catalog === undefined) {
    throw new LlmError(`${name}: the installed @earendil-works/pi-ai ships no "${CATALOG_PROVIDER}" catalog provider; upgrade pi-ai to 0.82.1 or newer`, 'NO_CATALOG');
  }

  const displayName = config.displayName ?? 'OpenAI Codex';
  let models = catalog.getModels();
  if (Array.isArray(config.models) && config.models.length > 0) {
    const known = new Map(models.map((model) => [model.id, model]));
    models = config.models.map((id) => {
      const model = known.get(id);
      if (model === undefined) {
        throw new LlmError(`${name}: config.models names "${id}", which the ${CATALOG_PROVIDER} catalog does not ship (known ids: ${[...known.keys()].join(', ')})`, 'INVALID_CONFIG');
      }
      return model;
    });
  }
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
    getModels: () => models,
    stream: (model, context, options) => catalog.stream(model, context, options),
    streamSimple: (model, context, options) => catalog.streamSimple(model, context, options),
  };

  const profile = {
    provider: route,
    displayName,
    piProvider,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `${name}: config.retryPolicy`),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 300_000,
    configuredMaxTokens: new Map(),
    ...(config.reasoning === undefined ? {} : { reasoning: config.reasoning }),
  };
  return {
    profiles: new Map([[route, profile]]),
    route,
    authPath: config.authPath ?? defaultCodexAuthPath(),
    refreshMarginMs: config.refreshMarginMs ?? 60_000,
  };
}

/**
 * Register the openai-codex route: one PiAiAdapter whose per-request
 * credential is the ChatGPT access token from the Codex auth file.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/schemastery').output<typeof Config>} config
 */
export function apply(ctx, config) {
  const { profiles, route, authPath, refreshMarginMs } = resolveRoute(config ?? {});
  const auth = createCodexAuth({ path: authPath, refreshMarginMs });

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => auth.getAccessToken(),
    resolveAttachments: () => ctx.get('attachments'),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`${name}: unusable replay state on assistant history for route "${provider}/${model}"; sending that message as provider-neutral content (${reason})`);
    },
  });
  ctx.llm.registerAdapter([route], adapter);
  ctx.logger.info(`${name}: provider route "${route}" serving ${profiles.get(route).piProvider.getModels().length} model(s) from the Codex catalog, credentials from ${auth.path}`);
}
