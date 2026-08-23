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
      exact(v, ['storage', 'source', 'connected', 'accountId', 'expiresAt', 'pending', 'error'], 'status');
      const pending = v.pending === null ? null : (() => {
        const p = asObject(v.pending, 'pending');
        exact(p, ['kind', 'expiresAt', 'userCode', 'verificationUri'], 'pending');
        asEnum(p.kind, ['browser', 'device'], 'pending.kind');
        asFinite(p.expiresAt, 'pending.expiresAt');
        if (p.kind === 'device') { asString(p.userCode, 'pending.userCode'); asString(p.verificationUri, 'pending.verificationUri'); }
        return { ...p };
      })();
      return {
        storage: asEnum(v.storage, ['dsh', 'codex', 'custom'], 'status.storage'),
        source: asString(v.source, 'status.source'),
        connected: asBoolean(v.connected, 'status.connected'),
        accountId: v.accountId === null ? null : asString(v.accountId, 'status.accountId'),
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
      call('disconnect', [], result(status)),
    ] });

    const styles = {
      card: { boxSizing: 'border-box', width: '100%', minWidth: 0, padding: 18, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', display: 'grid', gap: 14, overflow: 'hidden' },
      header: { display: 'grid', gap: 4, textAlign: 'left' },
      headerButton: { width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left' },
      body: { display: 'grid', gap: 14, paddingTop: 2 },
      chevron: { marginLeft: 'auto', flex: '0 0 auto', fontSize: 22, lineHeight: 1, transition: 'transform 150ms ease' },
      title: { margin: 0, fontSize: 16, lineHeight: '22px' },
      muted: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '19px' },
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

    function CodexAuthCard({ remote }) {
      const [snapshot, setSnapshot] = React.useState(null);
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
      React.useEffect(() => {
        let active = true;
        const load = async () => { if (active) await refresh(); };
        void load();
        const timer = setInterval(load, 1250);
        return () => { active = false; clearInterval(timer); };
      }, [refresh]);
      const action = async (operation) => {
        setBusy(true);
        try {
          await operation();
          await refresh();
        } catch (cause) {
          setFailure(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      };
      const connected = snapshot?.connected === true;
      const pending = snapshot?.pending;
      const custom = snapshot?.storage === 'custom';
      const statusText = snapshot === null ? 'Checking connection…' : connected ? `Connected${snapshot.accountId ? ` · account ${snapshot.accountId}` : ''} · ${expiry(snapshot.expiresAt)}` : 'Not connected';
      const connectLabel = connected ? 'Reconnect in browser' : 'Connect ChatGPT in browser';
      return h('section', { style: styles.card, 'aria-busy': busy },
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
          h('button', { type: 'button', style: styles.button, disabled: busy || Boolean(pending) || custom, onClick: () => void action(async () => {
            const login = remoteValue(await remote.beginBrowserLogin());
            setBrowserUrl(login.url);
            window.open(login.url, 'dsh-chatgpt-login', 'popup,width=560,height=720');
          }) }, connectLabel),
          h('button', { type: 'button', style: styles.button, disabled: busy || Boolean(pending) || custom, onClick: () => void action(async () => { remoteValue(await remote.beginDeviceLogin()); }) }, 'Use device code'),
          h('button', { type: 'button', style: styles.button, disabled: busy || Boolean(pending) || snapshot?.storage !== 'dsh', onClick: () => void action(async () => { remoteValue(await remote.disconnect()); setBrowserUrl(null); }) }, 'Disconnect DSH credentials')
        ),
        pending?.kind === 'browser' ? h('p', { style: styles.muted }, 'Waiting for approval in your browser. ', browserUrl ? h('a', { href: browserUrl, target: '_blank', rel: 'noreferrer' }, 'Open the authorization page again') : null) : null,
        pending?.kind === 'device' ? h('div', { style: styles.header },
          h('p', { style: styles.muted }, 'Open the device page and enter this code:'),
          h('div', { style: styles.code }, pending.userCode),
          h('a', { href: pending.verificationUri, target: '_blank', rel: 'noreferrer' }, pending.verificationUri)
        ) : null,
        failure || (snapshot?.error && snapshot.error !== 'Not connected') ? h('p', { style: styles.alert, role: 'alert' }, failure ?? snapshot.error) : null,
        snapshot?.storage === 'codex' ? h('p', { style: styles.muted }, 'Shared credentials are not deleted by DSH. To sign out of that source, use the Codex CLI; or switch to DSH-managed credentials first.') : null
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
      const authRemote = Object.fromEntries(['status', 'selectStorage', 'beginBrowserLogin', 'beginDeviceLogin', 'disconnect'].map((method) => [method, (...args) => {
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
