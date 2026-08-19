# dsh-llm-openai-codex

Use your **ChatGPT Plus/Pro subscription** (OpenAI Codex OAuth) as a model provider in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — no `OPENAI_API_KEY` required.

The harness ships providers that authenticate with API keys (`dsh-llm-deepseek`, `dsh-llm-pi-ai`). This plugin adds the missing subscription route: it runs pi-ai's built-in `openai-codex` provider (`https://chatgpt.com/backend-api` — the same backend and wire protocol the Codex CLI uses). The Codex models (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-*`, …) appear in the model picker under `openai-codex`.

## Connect from DSH Web

After installation, open **Settings → Plugin Configuration → OpenAI Codex / ChatGPT subscription**.

- **Connect ChatGPT in browser** starts PKCE OAuth at `https://auth.openai.com/` and receives the approved redirect at `http://localhost:1455/auth/callback`.
- **Use device code** is the browser-login fallback for a busy callback port, remote browser, or headless host. It displays a code for `https://auth.openai.com/codex/device` and polls safely in the background.
- **Credential storage** selects either **DSH-managed** credentials (`$DSH_HOME/credentials/openai-codex.json`) or the **shared Codex CLI** file (`~/.codex/auth.json` / `$CODEX_HOME/auth.json`). The latter preserves the old workflow; the former means the Codex CLI is not required.
- **Reconnect** starts a new OAuth login. **Disconnect** only deletes DSH-managed credentials; DSH will never remove the Codex CLI's auth file.

## How it works

- **Freshness**: the access token's own JWT `exp` decides when to refresh (60 s margin by default).
- **Refresh**: `POST https://auth.openai.com/oauth/token` with the public Codex CLI client id (`app_EMoamEEZ73f0CkXaXp7hrann`). The rotated pair is written back **atomically** (temp file + rename, `0600`). If a shared-file refresh loses a token-rotation race, the file is reloaded and retried once.
- **Requests**: reuse pi-ai's `openai-codex-responses` protocol and the harness's generic `PiAiAdapter` for message/tool-call/stream conversion. The `Authorization`, `chatgpt-account-id`, `originator`, and `OpenAI-Beta` headers are derived by pi-ai from the access token itself.
- **Settings interface**: a host settings namespace makes the card discoverable without modifying DSH's generic Models page; a package-private Typert Remote carries only secret-free connection state and OAuth actions to the browser.

## Prerequisites

An active ChatGPT Plus/Pro (or Business/Enterprise) subscription with Codex access. Codex CLI login remains optional if you select DSH-managed credentials.

## Install into a dsh profile

This package must be resolvable from your profile directory and added as a row in the profile's patch layer. For the default `web` profile:

```sh
# 1. install the package into the profile (no pnpm on PATH? run it through
#    corepack: COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm add …)
cd ~/.dsh/profiles
pnpm add dsh-llm-openai-codex@file:/path/to/dsh-codex-plugin --filter ./web
```

With pnpm on `PATH`, `dsh plugin --profile web add dsh-llm-openai-codex@file:/path/to/dsh-codex-plugin` does the same thing.

```yaml
# 2. ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: llm-openai-codex
      name: 'dsh-llm-openai-codex'
```

Restart `dsh web` (or your entry point), choose an `openai-codex/…` model, and configure the connection under Settings → Plugin Configuration.

## Configuration

Every key is optional; defaults shown:

```yaml
- insert:
    - id: llm-openai-codex
      name: 'dsh-llm-openai-codex'
      config:
        route: openai-codex                 # provider key in pickers: openai-codex/<model>
        displayName: OpenAI Codex
        storage: codex                      # initial source; UI can change to dsh
        authPath: ~/.codex/auth.json        # optional: pin a custom path and disable the source selector
        refreshMarginMs: 60000              # refresh this long before JWT exp
        streamIdleTimeoutMs: 300000
        reasoning: medium                   # default effort for reasoning models
        models: [gpt-5.4, gpt-5.4-mini]     # narrow the picker list
        retryPolicy: { mode: normal, maxRetries: 2 }
```

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| Callback port 1455 is busy | Another Codex/DSH OAuth flow owns the browser redirect | Choose **Use device code** in the card |
| `Not connected` | The selected credential source has no ChatGPT OAuth login | Connect in the Settings card, or select the shared Codex CLI source |
| `holds an API-key login … not the ChatGPT subscription` | Shared Codex CLI file is an API-key login | Re-login to Codex with ChatGPT, or use DSH-managed credentials |
| `refresh token was rejected … sign in again` | Token expired or rotated by another client | Reconnect in the card |
| 401 mid-session | A shared Codex CLI re-login invalidated old tokens | Usually self-heals by reloading the file; otherwise reconnect |

## Development

```sh
npm install
npm test            # unit + registration tests, no network
npm run smoke:live  # real request through your subscription (~a few tokens)
```

Layout: `lib/auth.js` — credential parsing/JWT refresh/atomic persistence; `lib/oauth.js` — browser PKCE, callback lifecycle, device flow, and source selection; `lib/remote.js` + `lib/client.js` — the secret-free Settings Remote and card; `lib/index.js` — Cordis model-route and settings registration.
