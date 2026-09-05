# dsh-llm-openai-codex

[![npm version](https://img.shields.io/npm/v/dsh-llm-openai-codex.svg)](https://www.npmjs.com/package/dsh-llm-openai-codex)

Use a ChatGPT Plus, Pro, Business, or Enterprise subscription with Codex access as a DeepSeek Harness model provider.

This plugin adds the `openai-codex` route to DSH.
It uses OpenAI Codex OAuth, not `OPENAI_API_KEY`.
It uses pi-ai's Codex backend at `https://chatgpt.com/backend-api`.

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Background

The existing pi-ai adapter in DeepSeek Harness authenticates provider routes with API keys alone.
pi-ai's OAuth-backed providers have no key to resolve, so its own validation refuses them.
This plugin closes that gap for OpenAI's Codex backend: it reuses the pi-ai catalog's `openai-codex` provider and the generic pi-ai request machinery, and answers each request's credential with a ChatGPT OAuth access token.

The token is loaded from either a DSH-managed credential file or the Codex CLI's shared auth file, and refreshed when it nears expiry.
pi-ai derives the Codex request headers from that token, so the backend sees only a normal Codex client.
The paired Web card starts a browser PKCE OAuth login or a device-code fallback, and exposes only secret-free connection status.

- Access-token freshness uses the JWT `exp` value with a 60-second default margin.
- Refresh requests use OpenAI's public Codex CLI OAuth client id.
- Token updates use a temporary file, `rename`, and mode `0600`.
- A shared-file refresh race reloads the credential file and retries once.
- The route retries empty-body and transient provider errors twice by default; set `retryPolicy` to change this.
- A login attempt waits 10 minutes at most and shows its remaining time; **Cancel this login** ends it at once.
- The DSH Settings card receives connection state and OAuth actions only.

## Install

Requirements:

- DeepSeek Harness `0.1.1-rc.2` or `0.1.2-rc.1` with a `web` profile.
- Node.js `>=22.19.0`.
- A ChatGPT subscription that includes Codex access.
- Either DSH-managed credentials or a ChatGPT Codex CLI login.

The plugin does not work with an API-key-only Codex CLI login.
No `OPENAI_API_KEY` is required.

Replace `web` below if you use another DSH profile.
The package must be a dependency of that profile.
Then add the `insert` row to that profile's `cordis.patch.yml`.

### npm registry

Use this route after the package is published to npm.

```sh
dsh plugin --profile web add dsh-llm-openai-codex
```

### GitHub

Use this route after the public GitHub repository is pushed.

```sh
dsh plugin --profile web add github:auggie246/dsh-llm-openai-codex
```

Git-hosted packages run `prepare` during installation.
pnpm 10 can block that script.
If it does, pnpm prints the blocked package key.
For this package, the key is exactly `dsh-llm-openai-codex`.

Add this to `~/.dsh/profiles/web/pnpm-workspace.yaml`.
Then run the same install command again.

```yaml
allowBuilds:
  dsh-llm-openai-codex: true
```

Use the key pnpm prints if a future pnpm version prints a different key.
Do not allow an unrecognized key.

### Activate the plugin

Add this exact block to `~/.dsh/profiles/web/cordis.patch.yml`.

```yaml
- insert:
    - id: llm-openai-codex
      name: 'dsh-llm-openai-codex'
```

Restart `dsh web`, or restart your DSH entry point.
Then select an `openai-codex/<model>` model.
Configure the connection in **Settings → Plugin Configuration → OpenAI Codex / ChatGPT subscription**.

### Uninstall

First remove the `llm-openai-codex` `insert` row from `cordis.patch.yml`.
Then remove the dependency from the same profile.

```sh
dsh plugin --profile web remove dsh-llm-openai-codex
```

Restart `dsh web`, or restart your DSH entry point.
Removing the plugin does not delete shared Codex CLI credentials.
Delete `$DSH_HOME/credentials/openai-codex.json` yourself only when you no longer need DSH-managed credentials.

## Usage

The Settings card supports two credential sources.

- **DSH-managed** stores credentials at `$DSH_HOME/credentials/openai-codex.json`.
- **Shared Codex CLI** reads `~/.codex/auth.json` or `$CODEX_HOME/auth.json`.

DSH-managed credentials are the default for a new installation.
Use **Connect ChatGPT in browser** to create them.
DSH receives the OAuth callback at `http://localhost:1455/auth/callback`.
Use **Use device code** when the callback port is busy or the browser is remote.

For the shared Codex CLI source, sign in through the Codex CLI with ChatGPT.
The shared source is read-only for interactive DSH login.
The plugin never starts an OAuth login that can replace the Codex CLI file.
The plugin refreshes the shared token pair safely when necessary.
The plugin never deletes the shared Codex CLI credential file.

Every plugin configuration key is optional.

```yaml
- insert:
    - id: llm-openai-codex
      name: 'dsh-llm-openai-codex'
      config:
        route: openai-codex
        displayName: OpenAI Codex
        storage: dsh
        # authPath: ~/.codex/auth.json
        refreshMarginMs: 60000
        streamIdleTimeoutMs: 300000
        reasoning: medium
        models: [gpt-5.4, gpt-5.4-mini]
        retryPolicy: { mode: normal, maxRetries: 2 }
```

`authPath` pins the credential file and disables the Settings source selector.
`route` changes the provider prefix shown in model pickers.
Changing `route` can conflict with another plugin that owns the same route.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| pnpm blocks `prepare` | Git installation needs an approved build script | Add the exact pnpm key under `allowBuilds`, then retry |
| Callback port `1455` is busy | Another OAuth flow owns the redirect port | Use **Use device code** |
| `Not connected` | The selected source has no ChatGPT OAuth login | Connect in Settings or select the Codex CLI source |
| API-key login message | The Codex CLI file has an API-key login | Log in to Codex with ChatGPT or use DSH-managed credentials |
| Refresh token rejected | The token expired or another client rotated it | Reconnect in Settings |
| Stuck on "Waiting for approval" | The browser closed before approval; the attempt waits 10 minutes | Use **Cancel this login** on the card, or wait out the countdown, then start again |
| `Request failed` on a Codex turn | The backend sent an empty error response | The route retries twice by default. If it repeats every turn, check the connection in Settings |

## Security

The package contains no user credentials, API keys, or telemetry settings.
`CODEX_CLIENT_ID` is OpenAI's public Codex CLI OAuth client identifier.
It identifies the OAuth application and cannot authenticate a user.
The plugin contacts OpenAI only for login, token refresh, and model requests.
It does not send local credential paths or account identifiers to the Web card.
It writes DSH-managed credentials with mode `0600`.
The Settings Remote never sends access or refresh tokens to the browser.

## Maintainers

[@auggie246](https://github.com/auggie246)

## Contributing

PRs accepted.

Small note: If editing the README, please conform to the [standard-readme specification](https://github.com/RichardLitt/standard-readme).

```sh
npm install
npm run build
npm test
npm run smoke:live
```

`npm run build` verifies every runtime artifact named by `main` and `exports`.
The package ships prebuilt JavaScript files from `lib/`.
`npm run smoke:live` uses your subscription and can spend tokens.

## License

MIT © Augustine Teo
