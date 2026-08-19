# dsh-llm-openai-codex

Use your **ChatGPT Plus/Pro subscription** (OpenAI Codex OAuth) as a model provider in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — no `OPENAI_API_KEY` required.

The harness ships providers that authenticate with API keys (`dsh-llm-deepseek`, `dsh-llm-pi-ai`). This plugin adds the missing subscription route: it runs pi-ai's built-in `openai-codex` provider (`https://chatgpt.com/backend-api` — the same backend and wire protocol the Codex CLI uses) and authenticates it with the OAuth tokens from your **Codex CLI login**. The codex models (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-*`, …) appear in the model picker under the `openai-codex` provider.

## How it works

- **Credentials**: reads the Codex CLI's auth file (`~/.codex/auth.json`, or `$CODEX_HOME/auth.json`). A pi OAuth entry (`{"type":"oauth","access","refresh","expires"}`) is accepted too.
- **Freshness**: the access token's own JWT `exp` decides when to refresh (60 s margin by default).
- **Refresh**: `POST https://auth.openai.com/oauth/token` with the public Codex CLI client id (`app_EMoamEEZ73f0CkXaXp7hrann`) — the flow Codex CLI and pi run. The rotated pair is written back **atomically** (temp file + rename, `0600`) so the Codex CLI keeps working from the same file. If a refresh is rejected because another client rotated first, the file is reloaded and retried once.
- **Requests**: reuse pi-ai's `openai-codex-responses` protocol and the harness's generic `PiAiAdapter` for message/tool-call/stream conversion. The `Authorization`, `chatgpt-account-id`, `originator`, and `OpenAI-Beta` headers are derived by pi-ai from the access token itself.

Sign-in is **not** handled by this plugin — use the Codex CLI.

## Prerequisites

1. An active ChatGPT Plus/Pro (or Business/Enterprise) subscription with Codex access.
2. Signed in with the [Codex CLI](https://github.com/openai/codex):

   ```sh
   codex login        # choose "Sign in with ChatGPT"
   ```

   Headless machine? `codex login --device-auth` works the same way.

## Install into a dsh profile

This package must be resolvable from your profile directory and added as a row in the profile's patch layer. For the default `web` profile:

```sh
# 1. install the package into the profile
cd ~/.dsh/profiles
pnpm add dsh-llm-openai-codex@file:/path/to/dsh-codex-plugin --filter ./web
```

```yaml
# 2. ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: llm-openai-codex
      name: 'dsh-llm-openai-codex'
```

Restart `dsh web` (or your entry point) and pick any `openai-codex/…` model in the selector.

## Configuration

Every key is optional; defaults shown:

```yaml
- insert:
    - id: llm-openai-codex
      name: 'dsh-llm-openai-codex'
      config:
        route: openai-codex                 # provider key in pickers: openai-codex/<model>
        displayName: OpenAI Codex
        authPath: ~/.codex/auth.json        # or set CODEX_HOME
        refreshMarginMs: 60000              # refresh this long before JWT exp
        streamIdleTimeoutMs: 300000
        reasoning: medium                   # default effort for reasoning models
        models: [gpt-5.4, gpt-5.4-mini]     # narrow the picker list
        retryPolicy: { mode: normal, maxRetries: 2 }
```

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `no Codex credentials at …/auth.json` | Not signed in (or `CODEX_HOME` points elsewhere) | `codex login` → "Sign in with ChatGPT" |
| `holds an API-key login … not the ChatGPT subscription` | You ran `codex login --api-key` | Run `codex login` and choose ChatGPT sign-in |
| `refresh token was rejected … sign in again` | Token expired or rotated by another client | `codex login` again |
| 401 mid-session | The Codex CLI re-logged and invalidated old tokens | Usually self-heals on next request (file reload); otherwise re-login |

## Development

```sh
npm install
npm test            # unit + registration tests, no network
npm run smoke:live  # real request through your subscription (~a few tokens)
```

Layout: `lib/auth.js` — the credential file (parse / JWT-expiry / refresh / atomic write-back); `lib/index.js` — the Cordis plugin (config schema, profile materialization, `ctx.llm.registerAdapter`).
