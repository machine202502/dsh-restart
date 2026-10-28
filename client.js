window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let createPortal = null;
    try { createPortal = require('react-dom').createPortal; } catch { createPortal = null; }

    const STRINGS = {
      en: {
        title: 'Restart DeepSeek Harness?',
        text: 'The app closes and starts again. Running turns are interrupted.',
        keep: 'Continue this session after the restart',
        cancel: 'Cancel',
        restart: 'Restart',
        restarting: 'Restarting…',
        tooltip: 'Restart DeepSeek Harness',
        rowLabel: 'Restart DeepSeek Harness',
        failed: 'Could not restart',
        toolEnabled: 'dsh_restart is available to agents',
        toolEnabledHint: 'when off, the tool disappears and calls fail',
        watchdog: 'Watchdog is active',
        watchdogHint: 'rolls the profile back when the app does not return',
        seconds: 'Watchdog wait, seconds',
        secondsHint: '1–120',
        save: 'Save',
        saved: 'Saved',
        unavailable: 'Settings service is unavailable',
        saveFailed: 'Could not save',
        loading: 'Loading settings…',
      },
      ru: {
        title: 'Перезапустить DeepSeek Harness?',
        text: 'Приложение закроется и запустится заново. Текущие ходы будут прерваны.',
        keep: 'Продолжить сессию после перезапуска',
        cancel: 'Отмена',
        restart: 'Перезапустить',
        restarting: 'Перезапускаю…',
        tooltip: 'Перезапустить DeepSeek Harness',
        rowLabel: 'Перезапустить DeepSeek Harness',
        failed: 'Не удалось перезапустить',
        toolEnabled: 'Команда dsh_restart доступна агенту',
        toolEnabledHint: 'если выключить — инструмент исчезнет, вызовы будут падать',
        watchdog: 'Сторож активен',
        watchdogHint: 'откатывает профиль, если приложение не поднялось',
        seconds: 'Ожидание сторожа, сек',
        secondsHint: '1–120',
        save: 'Сохранить',
        saved: 'Сохранено',
        unavailable: 'Сервис настроек недоступен',
        saveFailed: 'Не удалось сохранить',
        loading: 'Загрузка настроек…',
      },
    };

    const LOCALE = (() => {
      const lang = (document?.documentElement?.lang || navigator?.language || 'en').toLowerCase();
      return lang.startsWith('ru') ? STRINGS.ru : STRINGS.en;
    })();

    const PORT = 49233;
    const base = `http://127.0.0.1:${PORT}`;
    const CONTINUE_TEXT = '[auto.continue]';
    const FAILED_TEXT = '[auto.continue.failed]';

    const ensureStyles = () => {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin="dsh-restart"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-restart';
      tag.textContent = `
/* Mirrors the account row below it: 260x44, 6px padding, 8px gap, 12px radius,
   14px label, 24px avatar circle. */
.hr-footer-button { display: flex; align-items: center; gap: 8px; width: 260px; height: 44px;
  flex: none; margin-left: -2px; padding: 6px; border: none; border-radius: 12px; background: transparent;
  font: inherit; font-size: 14px; color: var(--dsw-alias-label-primary, #1b1b1f);
  cursor: pointer; text-align: left; }
.hr-footer-button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .05)); }
.hr-footer-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  flex: none; border-radius: 999px; overflow: hidden;
  background: var(--dsw-alias-interactive-bg, rgba(0, 0, 0, .04));
  color: var(--dsw-alias-label-secondary, #5f5f63); }
.hr-footer-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.hr-overlay { position: fixed; inset: 0; z-index: 4000; display: flex; align-items: center;
  justify-content: center; padding: 24px; background: rgba(0, 0, 0, .24); }
.hr-dialog { width: 380px; max-width: 100%; max-height: 100%; overflow: auto; padding: 0 0 24px;
  border-radius: 28px; background: var(--dsw-alias-bg-l1, #fff); color: var(--dsw-alias-label-primary, #0f1115);
  box-shadow: 0 0 0 .5px rgba(0, 0, 0, .16), 0 3px 8px rgba(0, 0, 0, .04), 0 0 20px rgba(0, 0, 0, .05); }
.hr-header { padding: 22px 24px 12px; }
.hr-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.hr-error { padding: 0 24px 12px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-danger, #e5484d); }
.hr-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.hr-btn { height: 36px; padding: 0 14px; border-radius: 12px; border: .5px solid rgba(0, 0, 0, .1);
  background: transparent; color: var(--dsw-alias-label-primary, #0f1115); font: inherit;
  font-size: 14px; line-height: 22px; cursor: pointer; }
.hr-btn:hover { background: rgba(0, 0, 0, .05); }
.hr-btn-primary { padding: 0 16px; border-color: transparent; background: var(--dsw-alias-label-primary, #0f1115);
  color: #fff; font-weight: 500; }
.hr-btn-primary:hover { background: #000; }
.hr-btn[disabled] { opacity: .6; cursor: default; }
.hr-set { display: flex; flex-direction: column; gap: 18px; max-width: 560px; padding: 4px 0 8px;
  font-size: 13px; line-height: 20px; }
.hr-set-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 36px; }
.hr-set-label { color: inherit; }
.hr-set-hint { margin-top: 2px; font-size: 12px; line-height: 16px; color: #8a8a8a; }
.hr-set-input { width: 88px; height: 32px; padding: 0 10px; border: 1px solid #dcdcdc; border-radius: 10px;
  background: #fff; color: inherit; font: inherit; outline: none; box-sizing: border-box; }
.hr-set-input:focus { border-color: #9a9a9a; }
.hr-set-switch { appearance: none; -webkit-appearance: none; position: relative; width: 36px; height: 20px; margin: 0;
  border-radius: 999px; background: #d9d9d9; cursor: pointer; transition: background 120ms ease; flex: none; }
.hr-set-switch:checked { background: #1f1f1f; }
.hr-set-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; transition: transform 120ms ease; }
.hr-set-switch:checked::after { transform: translateX(16px); }
.hr-set-actions { display: flex; align-items: center; gap: 12px; padding-top: 6px; }
.hr-set-save { height: 34px; padding: 0 16px; border: none; border-radius: 10px; background: #1f1f1f; color: #fff;
  font: inherit; cursor: pointer; }
.hr-set-save:disabled { opacity: 0.45; cursor: default; }
.hr-set-status { font-size: 12px; color: #8a8a8a; }
.hr-set-status--error { color: #c0392b; }
.hr-overlay { position: fixed; inset: 0; z-index: 4000; display: flex; align-items: center;
  justify-content: center; padding: 24px; background: rgba(0, 0, 0, .24); }
.hr-dialog { width: 380px; max-width: 100%; max-height: 100%; overflow: auto; padding: 0 0 24px;
  border-radius: 28px; background: var(--dsw-alias-bg-l1, #fff); color: var(--dsw-alias-label-primary, #0f1115);
  box-shadow: 0 0 0 .5px rgba(0, 0, 0, .16), 0 3px 8px rgba(0, 0, 0, .04), 0 0 20px rgba(0, 0, 0, .05); }
.hr-header { padding: 22px 24px 12px; }
.hr-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.hr-error { padding: 0 24px 12px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-danger, #e5484d); }
.hr-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.hr-btn { height: 36px; padding: 0 14px; border-radius: 12px; border: .5px solid rgba(0, 0, 0, .1);
  background: transparent; color: var(--dsw-alias-label-primary, #0f1115); font: inherit;
  font-size: 14px; line-height: 22px; cursor: pointer; }
.hr-btn:hover { background: rgba(0, 0, 0, .05); }
.hr-btn-primary { padding: 0 16px; border-color: transparent; background: var(--dsw-alias-label-primary, #0f1115);
  color: #fff; font-weight: 500; }
.hr-btn-primary:hover { background: #000; }
.hr-btn[disabled] { opacity: .6; cursor: default; }
.hr-settings { display: flex; flex-direction: column; gap: 10px; padding: 10px 0; max-width: 520px; }
.hr-field { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.hr-field span.hint { opacity: .65; font-size: 12px; }
.hr-field input[type="number"] { width: 72px; height: 28px; padding: 0 8px; border-radius: 8px;
  border: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); background: transparent; color: inherit; font: inherit; }
.hr-settings-actions { display: flex; align-items: center; gap: 10px; }
.hr-settings-status { font-size: 12px; opacity: .7; }
`;
      document.head.appendChild(tag);
    };

    const post = async (path, body) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
      return data;
    };

    const diag = (stage, data) => {
      try {
        void fetch(`${base}/diag`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage, data }),
        });
      } catch {
        // Bridge down: diagnostics are optional.
      }
    };

    const findComposer = () => document.querySelector('[contenteditable="true"][role="textbox"]')
      ?? document.querySelector('[contenteditable="true"]')
      ?? document.querySelector('textarea');

    const editorText = (area) => (area instanceof HTMLTextAreaElement ? area.value : (area.innerText ?? area.textContent ?? '')).trim();

    const findSendButton = () => [...document.querySelectorAll('button')]
      .find((button) => /send|submit|отправ/i.test(button.getAttribute('aria-label') ?? button.title ?? ''));

    const focusEditor = (area) => {
      area.focus();
      if (area instanceof HTMLTextAreaElement) return;
      const range = document.createRange();
      range.selectNodeContents(area);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const DRAFT_KEY = 'dsh-restart:draft';

    const saveDraft = (text) => {
      try { window.localStorage.setItem(DRAFT_KEY, text); } catch { /* storage off */ }
    };
    const loadDraft = () => {
      try { return window.localStorage.getItem(DRAFT_KEY) ?? ''; } catch { return ''; }
    };
    const dropDraft = () => {
      try { window.localStorage.removeItem(DRAFT_KEY); } catch { /* storage off */ }
    };

    const setComposerText = (area, text) => {
      focusEditor(area);
      if (area instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(area, text);
        area.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      document.execCommand('selectAll');
      if (text.length === 0) {
        document.execCommand('delete');
      } else {
        document.execCommand('insertText', false, text);
      }
    };

    /** Best-effort: post the auto-continue marker while keeping the user's draft. */
    const submitContinue = async (markerText) => {
      const area = findComposer();
      if (!area) return { ok: false, reason: 'no composer' };

      // Keep whatever the user was typing: park it, send the marker, put it back.
      const draft = editorText(area);
      if (draft !== '' && draft !== markerText) saveDraft(draft);
      if (draft !== '') {
        setComposerText(area, '');
        await sleep(200);
      }

      const restoreDraft = () => {
        const parked = loadDraft();
        if (!parked) return;
        const current = editorText(area);
        if (current === '') {
          setComposerText(area, parked);
          dropDraft();
        }
      };

      focusEditor(area);
      if (area instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(area, markerText);
        area.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, markerText);
      }

      for (let tick = 0; tick < 12; tick++) {
        await sleep(150);
        // Only the marker itself may ever be submitted.
        if (editorText(area) !== markerText) {
          if (editorText(area) === '') continue;
          restoreDraft();
          return { ok: false, reason: 'composer changed' };
        }
        const send = findSendButton();
        if (send === undefined || send.disabled) continue;
        send.click();
        await sleep(300);
        if (editorText(area) === '') {
          restoreDraft();
          return { ok: true, via: 'button', draftKept: draft !== '' };
        }
      }

      // Last resort: Enter, but again only for the marker text.
      if (editorText(area) === markerText) {
        const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        area.dispatchEvent(new KeyboardEvent('keydown', key));
        area.dispatchEvent(new KeyboardEvent('keyup', key));
        await sleep(300);
        if (editorText(area) === '') {
          restoreDraft();
          return { ok: true, via: 'enter', draftKept: draft !== '' };
        }
      }

      restoreDraft();
      return { ok: false, reason: 'not submitted', text: editorText(area) };
    };

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    /** Confirmation dialog as plain DOM: react-dom is not in the module table. */
    const openDialog = ({ sessionId, strings, onClose }) => {
      ensureStyles();
      const overlay = el('div', 'hr-overlay');
      const dialog = el('div', 'hr-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      const header = el('div', 'hr-header');
      const title = el('h2', 'hr-title', strings.title);
      title.id = 'hr-title';
      dialog.setAttribute('aria-labelledby', 'hr-title');
      header.append(title);
      dialog.append(header);

      const actions = el('div', 'hr-actions');
      const cancel = el('button', 'hr-btn', strings.cancel);
      const restart = el('button', 'hr-btn hr-btn-primary', strings.restart);
      restart.type = 'button';
      cancel.type = 'button';
      actions.append(cancel, restart);
      dialog.append(actions);
      const error = el('div', 'hr-error');
      error.hidden = true;
      dialog.append(error);
      overlay.append(dialog);

      let busy = false;
      const previousFocus = document.activeElement;
      const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        if (previousFocus instanceof HTMLElement) previousFocus.focus();
        onClose?.();
      };
      const onKey = (event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          close();
          return;
        }
        // Keep Tab inside the dialog, the way the host modal does.
        if (event.key !== 'Tab') return;
        const focusable = [cancel, restart].filter((button) => !button.disabled);
        if (focusable.length === 0) return;
        const index = focusable.indexOf(document.activeElement);
        const next = event.shiftKey
          ? (index <= 0 ? focusable[focusable.length - 1] : focusable[index - 1])
          : (index === -1 || index === focusable.length - 1 ? focusable[0] : focusable[index + 1]);
        event.preventDefault();
        next.focus();
      };

      overlay.addEventListener('click', () => { if (!busy) close(); });
      dialog.addEventListener('click', (event) => event.stopPropagation());
      cancel.addEventListener('click', () => { if (!busy) close(); });
      restart.addEventListener('click', async () => {
        busy = true;
        restart.disabled = true;
        cancel.disabled = true;
        restart.textContent = strings.restarting;
        error.hidden = true;
        if (sessionId) {
          try { window.localStorage.setItem('dsh-restart:session', sessionId); } catch { /* storage off */ }
        }
        try {
          // The restart always reopens this session and posts "continue".
          await post('/restart', { sessionId: sessionId ?? null });
        } catch (failure) {
          busy = false;
          restart.disabled = false;
          cancel.disabled = false;
          restart.textContent = strings.restart;
          error.textContent = `${strings.failed}: ${failure?.message ?? failure}`;
          error.hidden = false;
        }
      });

      document.addEventListener('keydown', onKey);
      document.body.append(overlay);
      restart.focus();
    };

    const PowerIcon = () => h('svg', {
      width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
    },
    h('path', { d: 'M8 2.2v5.2' }),
    h('path', { d: 'M4.4 4.2a5.1 5.1 0 1 0 7.2 0' }));

    const tr = (t, key, fallback) => {
      if (typeof t !== 'function') return fallback;
      try {
        const value = t(key);
        return typeof value === 'string' && value.length > 0 && value !== key ? value : fallback;
      } catch {
        return fallback;
      }
    };

    function RestartButton(props) {
      ensureStyles();
      const slotSession = props?.sessionId ?? props?.session?.id ?? null;
      const t = props?.t;
      const strings = {
        title: tr(t, 'dialog.title', LOCALE.title),
        cancel: tr(t, 'dialog.cancel', LOCALE.cancel),
        restart: tr(t, 'dialog.restart', LOCALE.restart),
        restarting: tr(t, 'dialog.restarting', LOCALE.restarting),
        tooltip: tr(t, 'dialog.tooltip', LOCALE.tooltip),
        failed: tr(t, 'dialog.failed', LOCALE.failed),
        label: tr(t, 'dialog.row', LOCALE.rowLabel),
      };
      return h('button', {
        className: 'hr-footer-button',
        title: strings.tooltip,
        'aria-label': strings.tooltip,
        onClick: () => openDialog({ sessionId: slotSession ?? lastSessionId(), strings, onClose: () => {} }),
      },
        h('span', { className: 'hr-footer-icon' }, h(PowerIcon)),
        h('span', { className: 'hr-footer-label' }, strings.label),
      );
    }

    const lastSessionId = () => {
      try { return window.localStorage.getItem('dsh-restart:session') ?? null; } catch { return null; }
    };

    /** After a restart with "continue", reopen the session and submit the text. */
    const resumeAfterRestart = async (uiWorkspace) => {
      let pending = null;
      let queued = false;
      let failed = false;
      try {
        const response = await fetch(`${base}/claim`);
        if (!response.ok) return;
        const claimed = await response.json();
        pending = claimed?.marker ?? null;
        queued = claimed?.queued === true;
        failed = claimed?.failed === true;
      } catch {
        return;
      }
      if (failed) pending = { ...(pending ?? {}), failed: true };
      // A pending queue keeps its messages: no marker is posted for it.
      if (queued) {
        diag('skip-queued', {});
        return;
      }
      diag('boot', { pending, hasWorkspace: Boolean(uiWorkspace) });
      if (!pending || pending.continue !== true) return;
      pending = { ...pending, failed };
      const sessionId = pending.sessionId ?? lastSessionId();
      if (sessionId && uiWorkspace?.openSession) {
        try {
          await uiWorkspace.openSession(sessionId);
          diag('opened', { sessionId, path: location.pathname, hash: location.hash, focused: document.hasFocus() });
        } catch (error) {
          diag('open-failed', { sessionId, message: String(error) });
        }
      }
      // Give the composer a moment to mount, then submit "continue".
      for (const delay of [800, 1500, 3000]) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        const result = await submitContinue(pending.failed === true ? FAILED_TEXT : CONTINUE_TEXT);
        diag('submit', result);
        if (result.ok) return;
      }
      diag('gave-up', {});
    };

    function SettingsForm() {
      ensureStyles();
      const [state, setState] = React.useState({ status: 'loading', values: {} });
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState({ text: '', error: false });

      React.useEffect(() => {
        let alive = true;
        fetch(`${base}/settings`)
          .then((response) => response.json())
          .then((data) => { if (alive) setState({ status: 'ready', values: data.values ?? {} }); })
          .catch(() => { if (alive) setState({ status: 'error', values: {} }); });
        return () => { alive = false; };
      }, []);

      const setValue = (key, value) => {
        setState((current) => ({ ...current, values: { ...current.values, [key]: value } }));
      };

      const save = async () => {
        setSaving(true);
        setNotice({ text: '', error: false });
        try {
          const response = await fetch(`${base}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(state.values),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? 'save failed');
          setState({ status: 'ready', values: data.values ?? state.values });
          setNotice({ text: LOCALE.saved, error: false });
        } catch (error) {
          setNotice({ text: String(error.message ?? error), error: true });
        } finally {
          setSaving(false);
        }
      };

      if (state.status === 'loading') {
        return h('div', { className: 'hr-set', style: { color: '#8a8a8a' } }, LOCALE.loading);
      }
      if (state.status === 'error') {
        return h('div', { className: 'hr-set', style: { color: '#c0392b' } }, LOCALE.unavailable);
      }

      const values = state.values ?? {};
      const row = (label, control, hint) => h('div', { className: 'hr-set-row' },
        h('div', null,
          h('div', { className: 'hr-set-label' }, label),
          hint ? h('div', { className: 'hr-set-hint' }, hint) : null,
        ),
        control,
      );
      const toggle = (key, checked) => h('input', {
        type: 'checkbox',
        className: 'hr-set-switch',
        checked,
        onChange: (event) => setValue(key, event.target.checked),
      });

      return h('div', { className: 'hr-set' },
        row(LOCALE.toolEnabled, toggle('toolEnabled', values.toolEnabled !== false), LOCALE.toolEnabledHint),
        row(LOCALE.watchdog, toggle('watchdogEnabled', values.watchdogEnabled !== false), LOCALE.watchdogHint),
        row(LOCALE.seconds, h('input', {
          type: 'number',
          min: 1,
          max: 120,
          className: 'hr-set-input',
          value: values.watchdogSeconds ?? 10,
          disabled: values.watchdogEnabled === false,
          onChange: (event) => setValue('watchdogSeconds', Number(event.target.value)),
        }), LOCALE.secondsHint),
        h('div', { className: 'hr-set-actions' },
          h('button', { className: 'hr-set-save', disabled: saving, onClick: save }, LOCALE.save),
          notice.text ? h('span', { className: `hr-set-status${notice.error ? ' hr-set-status--error' : ''}` }, notice.text) : null,
        ),
      );
    }

    return {
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        const report = (stage, error) => {
          try {
            void fetch(`${base}/diag`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ stage, error: String(error && error.stack ? error.stack : error) }),
            });
          } catch { /* bridge may be down */ }
        };
        try { void fetch(`${base}/client-loaded`); } catch { /* bridge may be down */ }
        try {
          applyInner(ctx, report);
        } catch (error) {
          // A broken plugin must not fail the whole web boot: report and stay inert.
          report('apply-crashed', error);
        }
      },
    };

    function applyInner(ctx, report) {
        try {
          ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config',
            key: 'dsh-restart#restart',
          }, SettingsForm));
        } catch (error) {
          console.warn('dsh-restart: settings slot failed', error);
        }
        try {
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'restart',
            order: 90,
            locale: 'restart',
            inject: (sessionId, t) => ({ sessionId, t }),
          }, RestartButton));
        } catch (error) {
          console.warn('dsh-restart: footer slot failed', error);
        }
        diag('applied', { hasEffect: typeof ctx.effect, hasWorkspace: typeof ctx.uiWorkspace });
        // Plain timer: a slot-scoped effect can be disposed before it fires, and
        // this work must survive the initial mount/unmount churn.
        setTimeout(() => {
          diag('boot-timer', {});
          void resumeAfterRestart(ctx.uiWorkspace);
        }, 1200);
    }
  },
});
