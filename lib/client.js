/*
 * Browser half of dsh-llm-openai-codex.
 *
 * dsh-client-modules consumes prebuilt client halves as lazy CJS factories;
 * keep this wrapper format (rather than native ESM) so one ordinary host
 * composition row delivers both the provider and this Settings card.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-openai-codex',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const h = React.createElement;
    const PACKAGE = 'dsh-llm-openai-codex';
    const SERVICE = 'codexAuth';

    // Typert needs strict codecs at both ends. These compact validators mirror
    // lib/remote.js and deliberately expose no token-bearing fields.
    const codec = (typeSymbol, parse) => Object.freeze({ mode: 'strict', typeSymbol, schema: Object.freeze({ _zod: {}, parse }) });
    const asObject = (value, label) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
      return value;
    };
    const asString = (value, label) => {
      if (typeof value !== 'string') throw new Error(`${label} must be a string`);
      return value;
    };
    const asBoolean = (value, label) => {
      if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
      return value;
    };
    const asFinite = (value, label) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a number`);
      return value;
    };
    const asEnum = (value, allowed, label) => {
      if (!allowed.includes(value)) throw new Error(`${label} is invalid`);
      return value;
    };
    const exact = (value, keys, label) => {
      for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label}.${key} is not allowed`);
    };
    const storage = codec(`${PACKAGE}/StorageSelection`, (value) => asEnum(value, ['dsh', 'codex'], 'storage'));
    const status = codec(`${PACKAGE}/CodexAuthStatus`, (value) => {
      const v = asObject(value, 'status');
      exact(v, ['storage', 'source', 'connected', 'expiresAt', 'pending', 'error'], 'status');
      const pending = v.pending === null ? null : (() => {
        const p = asObject(v.pending, 'pending');
        asEnum(p.kind, ['browser', 'device'], 'pending.kind');
        asFinite(p.expiresAt, 'pending.expiresAt');
        exact(p, p.kind === 'browser' ? ['kind', 'expiresAt', 'url'] : ['kind', 'expiresAt', 'userCode', 'verificationUri'], 'pending');
        if (p.kind === 'browser') { asString(p.url, 'pending.url'); }
        if (p.kind === 'device') { asString(p.userCode, 'pending.userCode'); asString(p.verificationUri, 'pending.verificationUri'); }
        return { ...p };
      })();
      return {
        storage: asEnum(v.storage, ['dsh', 'codex', 'custom'], 'status.storage'),
        source: asString(v.source, 'status.source'),
        connected: asBoolean(v.connected, 'status.connected'),
        expiresAt: v.expiresAt === null ? null : asFinite(v.expiresAt, 'status.expiresAt'),
        pending,
        error: v.error === null ? null : asString(v.error, 'status.error'),
      };
    });
    const browser = codec(`${PACKAGE}/BrowserLogin`, (value) => {
      const v = asObject(value, 'browser login'); exact(v, ['url'], 'browser login'); return { url: asString(v.url, 'browser login.url') };
    });
    const device = codec(`${PACKAGE}/DeviceLogin`, (value) => {
      const v = asObject(value, 'device login'); exact(v, ['kind', 'expiresAt', 'userCode', 'verificationUri'], 'device login');
      return { kind: asEnum(v.kind, ['device'], 'device login.kind'), expiresAt: asFinite(v.expiresAt, 'device login.expiresAt'), userCode: asString(v.userCode, 'device login.userCode'), verificationUri: asString(v.verificationUri, 'device login.verificationUri') };
    });
    const result = (entry) => ({ mode: 'strict', typeSymbol: entry.typeSymbol, schema: entry.schema });
    const modelsStatus = codec(`${PACKAGE}/CodexModelsStatus`, (value) => {
      const v = asObject(value, 'models status');
      exact(v, ['count', 'source', 'fetchedAt', 'error'], 'models status');
      return {
        count: asFinite(v.count, 'models status.count'),
        source: asEnum(v.source, ['catalog', 'cache', 'manifest'], 'models status.source'),
        fetchedAt: v.fetchedAt === null ? null : asFinite(v.fetchedAt, 'models status.fetchedAt'),
        error: v.error === null ? null : asString(v.error, 'models status.error'),
      };
    });
    const call = (method, parameters, output) => ({
      id: `${PACKAGE}#${SERVICE}/${method}`,
      service: SERVICE,
      namespace: SERVICE,
      method,
      invocation: { kind: 'direct' },
      parameters,
      result: output,
    });
    const storageParameter = { name: 'storage', wire: 'storage', source: 'json', codec: result(storage) };
    const TYPERT_REMOTE = Object.freeze({ package: PACKAGE, descriptors: [
      call('status', [], result(status)),
      call('selectStorage', [storageParameter], result(status)),
      call('beginBrowserLogin', [], result(browser)),
      call('beginDeviceLogin', [], result(device)),
      call('cancelLogin', [], result(status)),
      call('disconnect', [], result(status)),
      call('modelsStatus', [], result(modelsStatus)),
      call('refreshModels', [], result(modelsStatus)),
    ] });

    const styles = {
      // Match the owning PluginCard CSS metrics so this third-party card sits
      // alongside Shell, Agent loop, and Web search without visual drift.
      card: { boxSizing: 'border-box', width: '100%', minWidth: 0, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', transition: 'border-color 160ms, background 160ms' },
      header: { display: 'flex', flexDirection: 'column', flex: 1, gap: 4, minWidth: 0, textAlign: 'left' },
      headerButton: { appearance: 'none', width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', border: 0, borderRadius: 12, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left' },
      body: { display: 'grid', gap: 14, borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', padding: '14px 0 12px' },
      chevron: { color: 'var(--dsw-alias-label-tertiary)', marginLeft: 'auto', flex: '0 0 auto', fontSize: 18, lineHeight: 1, transition: 'transform 160ms ease' },
      title: { margin: 0, color: 'var(--dsw-alias-label-primary)', fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
      muted: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.5 },
      row: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      button: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', borderRadius: 6, padding: '7px 10px', font: 'inherit', fontSize: 13, cursor: 'pointer' },
      select: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', borderRadius: 6, padding: '7px 9px', font: 'inherit', fontSize: 13 },
      code: { letterSpacing: '.08em', fontSize: 18, fontWeight: 700, padding: '7px 10px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-1)' },
      alert: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, lineHeight: '19px' },
    };

    function remoteValue(result) {
      if (!result?.ok) throw new Error(result?.error?.message ?? 'The DSH server rejected this request.');
      return result.value;
    }
    function expiry(value) {
      if (value === null) return 'expiry unknown';
      return `expires ${new Date(value).toLocaleString()}`;
    }
    function pendingCountdown(expiresAt) {
      const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    function fetchedAgo(fetchedAt) {
      const seconds = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000));
      if (seconds < 90) return 'just now';
      const minutes = Math.round(seconds / 60);
      if (minutes < 90) return `${minutes} min ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 36) return `${hours} h ago`;
      return `${Math.round(hours / 24)} d ago`;
    }
    function modelsLine(models) {
      if (models === null) return 'checking model list…';
      const where = models.source === 'manifest' ? `live backend list, fetched ${fetchedAgo(models.fetchedAt ?? Date.now())}`
        : models.source === 'cache' ? `cached backend list, fetched ${fetchedAgo(models.fetchedAt ?? Date.now())}`
        : 'bundled Codex catalog';
      return `${models.count} model${models.count === 1 ? '' : 's'} · ${where}`;
    }

    function CodexAuthCard({ remote }) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [models, setModels] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [browserUrl, setBrowserUrl] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const refresh = React.useCallback(async () => {
        try {
          const next = remoteValue(await remote.status());
          setSnapshot(next);
          setFailure(null);
          return next;
        } catch (cause) {
          setFailure(cause instanceof Error ? cause.message : String(cause));
          return null;
        }
      }, [remote]);
      const refreshModels = React.useCallback(async () => {
        // Silent: the model row is informational, and a failure there must
        // not masquerade as a connection problem.
        try {
          setModels(remoteValue(await remote.modelsStatus()));
        } catch {
          // keep the previous row, if any
        }
      }, [remote]);
      React.useEffect(() => {
        let active = true;
        const load = async () => { if (active) await refresh(); };
        void load();
        void refreshModels();
        const timer = setInterval(load, 1250);
        return () => { active = false; clearInterval(timer); };
      }, [refresh, refreshModels]);
      const action = async (operation) => {
        setBusy(true);
        try {
          await operation();
          await refresh();
          await refreshModels();
        } catch (cause) {
          setFailure(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      };
      const connected = snapshot?.connected === true;
      const pending = snapshot?.pending;
      const custom = snapshot?.storage === 'custom';
      const shared = snapshot?.storage === 'codex';
      const readOnly = custom || shared;
      const statusText = snapshot === null ? 'Checking connection…' : connected ? `Connected · ${expiry(snapshot.expiresAt)}` : 'Not connected';
      const connectLabel = connected ? 'Reconnect in browser' : 'Connect ChatGPT in browser';
      return h('section', { style: { ...styles.card, ...(open ? { background: 'var(--dsw-alias-bg-layer-2)', borderColor: 'var(--dsw-alias-label-dimmed)' } : {}) }, 'aria-busy': busy },
        h('button', {
          type: 'button',
          style: styles.headerButton,
          'aria-expanded': open,
          'aria-label': `${open ? 'Collapse' : 'Expand'}: OpenAI Codex / ChatGPT subscription`,
          onClick: () => setOpen(!open),
        },
        h('div', { style: styles.header },
          h('h2', { style: styles.title }, 'OpenAI Codex / ChatGPT subscription'),
          h('p', { style: styles.muted }, 'Connect a ChatGPT subscription directly from DSH. OAuth tokens are stored separately from model settings and refresh automatically.')
        ),
        h('span', { style: { ...styles.chevron, transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }, 'aria-hidden': true }, '⌄')
        ),
        open ? h('div', { style: styles.body },
        h('p', { style: styles.muted }, statusText),
        h('label', { style: styles.row },
          h('span', { style: styles.muted }, 'Credential storage'),
          h('select', {
            style: styles.select,
            value: snapshot?.storage === 'dsh' ? 'dsh' : 'codex',
            disabled: busy || Boolean(pending) || custom,
            onChange: (event) => void action(async () => { remoteValue(await remote.selectStorage(event.currentTarget.value)); }),
          },
          h('option', { value: 'dsh' }, 'DSH-managed (recommended)'),
          h('option', { value: 'codex' }, 'Shared with Codex CLI (~/.codex)')),
          h('span', { style: styles.muted }, custom ? 'This deployment pins a custom auth file.' : snapshot ? snapshot.source : '')
        ),
        h('div', { style: styles.row },
          h('button', { type: 'button', style: styles.button, disabled: busy || Boolean(pending) || readOnly, onClick: () => {
            const popup = window.open('', 'dsh-chatgpt-login', 'popup,width=560,height=720');
            void action(async () => {
              const login = remoteValue(await remote.beginBrowserLogin());
              setBrowserUrl(login.url);
              popup?.location.assign(login.url);
            });
          } }, connectLabel),
          h('button', { type: 'button', style: styles.button, disabled: busy || Boolean(pending) || readOnly, onClick: () => void action(async () => { remoteValue(await remote.beginDeviceLogin()); }) }, 'Use device code'),
          h('button', { type: 'button', style: styles.button, disabled: busy || Boolean(pending) || snapshot?.storage !== 'dsh', onClick: () => void action(async () => { remoteValue(await remote.disconnect()); setBrowserUrl(null); }) }, 'Disconnect DSH credentials')
        ),
        pending?.kind === 'browser' ? h('p', { style: styles.muted }, `Waiting for approval in your browser — this attempt ends in ${pendingCountdown(pending.expiresAt)}. `, h('a', { href: pending.url ?? browserUrl, target: '_blank', rel: 'noreferrer' }, 'Open the authorization page again')) : null,
        pending?.kind === 'device' ? h('div', { style: styles.header },
          h('p', { style: styles.muted }, `Open the device page and enter this code — waiting ${pendingCountdown(pending.expiresAt)} more:`),
          h('div', { style: styles.code }, pending.userCode),
          h('a', { href: pending.verificationUri, target: '_blank', rel: 'noreferrer' }, pending.verificationUri)
        ) : null,
        pending ? h('div', { style: styles.row },
          h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => void action(async () => { remoteValue(await remote.cancelLogin()); setBrowserUrl(null); }) }, 'Cancel this login')
        ) : null,
        h('div', { style: styles.row },
          h('button', { type: 'button', style: styles.button, disabled: busy || !connected, onClick: () => void action(async () => { await remote.refreshModels(); }) }, 'Refresh model list'),
          h('span', { style: styles.muted }, modelsLine(models))
        ),
        models?.error ? h('p', { style: styles.muted }, `Model discovery last failed: ${models.error}`) : null,
        failure || (snapshot?.error && snapshot.error !== 'Not connected') ? h('p', { style: styles.alert, role: 'alert' }, failure ?? snapshot.error) : null,
        shared ? h('p', { style: styles.muted }, 'Shared Codex CLI credentials are read-only. Sign in through the Codex CLI, or switch to DSH-managed credentials for an interactive login.') : null
        ) : null
      );
    }

    const inject = ['slots', 'remote'];
    function apply(ctx) {
      // The Plugin Configuration tab discovers cards from the slot ledger.
      // Register immediately: a delayed or failed Remote mount must never make
      // the login surface disappear. The facade resolves its target at call
      // time, so an early first render safely reports "initializing" and later
      // calls use the mounted service without a second card registration.
      const authRemote = Object.fromEntries(['status', 'selectStorage', 'beginBrowserLogin', 'beginDeviceLogin', 'cancelLogin', 'disconnect', 'modelsStatus', 'refreshModels'].map((method) => [method, (...args) => {
        const target = ctx.get('remote.codexAuth');
        if (typeof target?.[method] !== 'function') return Promise.resolve({ ok: false, error: { message: 'The DSH OAuth connection is still initializing. Try again in a moment.' } });
        return target[method](...args);
      }]));
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: 'llm-openai-codex',
        inject: () => ({ remote: authRemote }),
      }, CodexAuthCard));
      ctx.effect(async () => {
        const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
        return async () => {
          await disposeRemote();
        };
      }, 'dsh-llm-openai-codex: OAuth Remote bridge');
    }
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
