window.__ModuleLoader__.load({
  id: 'hsb-restart',
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
      },
      ru: {
        title: 'Перезапустить DeepSeek Harness?',
        text: 'Приложение закроется и запустится заново. Текущие ходы будут прерваны.',
        keep: 'Продолжить сессию после перезапуска',
        cancel: 'Отмена',
        restart: 'Перезапустить',
        restarting: 'Перезапускаю…',
        tooltip: 'Перезапустить DeepSeek Harness',
      },
    };

    const LOCALE = (() => {
      const lang = (document?.documentElement?.lang || navigator?.language || 'en').toLowerCase();
      return lang.startsWith('ru') ? STRINGS.ru : STRINGS.en;
    })();

    const PORT = 49233;
    const base = `http://127.0.0.1:${PORT}`;
    const CONTINUE_TEXT = 'continue';

    const ensureStyles = () => {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin="hsb-restart"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'hsb-restart';
      tag.textContent = `
.hr-footer-button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #5f5f63); cursor: pointer; }
.hr-footer-button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #1b1b1f); }
.hr-overlay { position: fixed; inset: 0; z-index: 4000; display: flex; align-items: center; justify-content: center;
  background: rgba(12,12,14,.45); }
.hr-dialog { width: 380px; max-width: calc(100vw - 32px); border-radius: 14px; padding: 18px 18px 14px;
  background: var(--dsw-alias-bg-l1, #fff); color: var(--dsw-alias-label-primary, #1b1b1f);
  box-shadow: 0 24px 64px rgba(0,0,0,.28); border: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); }
.hr-title { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
.hr-text { font-size: 13px; line-height: 19px; color: var(--dsw-alias-label-secondary, #5f5f63); margin: 0 0 12px; }
.hr-check { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 0 0 16px; cursor: pointer; }
.hr-check input { width: 14px; height: 14px; accent-color: var(--dsw-alias-accent, #4d6bfe); }
.hr-actions { display: flex; justify-content: flex-end; gap: 8px; }
.hr-btn { height: 30px; padding: 0 14px; border-radius: 8px; font-size: 13px; cursor: pointer;
  border: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); background: transparent; color: inherit; }
.hr-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.hr-btn-primary { border-color: transparent; background: var(--dsw-alias-accent, #4d6bfe); color: #fff; }
.hr-btn-primary:hover { filter: brightness(1.05); }
.hr-btn[disabled] { opacity: .6; cursor: default; }
`;
      document.head.appendChild(tag);
    };

    const post = async (path, body) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return response.ok ? response.json().catch(() => ({})) : null;
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

    /** Best-effort: type "continue" into the composer and submit it. */
    const submitContinue = async () => {
      const area = findComposer();
      if (!area) return { ok: false, reason: 'no composer' };

      const clear = async () => {
        if (editorText(area) === '') return;
        focusEditor(area);
        if (area instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(area, '');
          area.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('selectAll');
          document.execCommand('delete');
        }
        await sleep(150);
      };

      for (const delay of [0, 300, 700, 1400]) {
        if (delay) await sleep(delay);
        await clear();

        focusEditor(area);
        if (area instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(area, CONTINUE_TEXT);
          area.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('insertText', false, CONTINUE_TEXT);
        }

        // The editor updates its model asynchronously: wait for the send button
        // to accept the draft before clicking it.
        for (let tick = 0; tick < 12; tick++) {
          await sleep(150);
          const send = findSendButton();
          if (send === undefined || send.disabled) continue;
          send.click();
          await sleep(300);
          if (editorText(area) === '') return { ok: true, via: 'button' };
        }

        const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        area.dispatchEvent(new KeyboardEvent('keydown', key));
        area.dispatchEvent(new KeyboardEvent('keyup', key));
        await sleep(300);
        if (editorText(area) === '') return { ok: true, via: 'enter' };
      }

      return {
        ok: false,
        reason: 'not submitted',
        text: editorText(area),
        send: findSendButton()?.getAttribute('aria-label') ?? null,
        focused: document.hasFocus(),
      };
    };

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    /** Confirmation dialog as plain DOM: react-dom is not in the module table. */
    const openDialog = ({ sessionId, onClose }) => {
      ensureStyles();
      const overlay = el('div', 'hr-overlay');
      const dialog = el('div', 'hr-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      const title = el('div', 'hr-title', LOCALE.title);
      title.id = 'hr-title';
      dialog.setAttribute('aria-labelledby', 'hr-title');
      dialog.append(title);
      dialog.append(el('div', 'hr-text', LOCALE.text));

      const check = el('label', 'hr-check');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      check.append(box, document.createTextNode(` ${LOCALE.keep}`));
      dialog.append(check);

      const actions = el('div', 'hr-actions');
      const cancel = el('button', 'hr-btn', LOCALE.cancel);
      const restart = el('button', 'hr-btn hr-btn-primary', LOCALE.restart);
      restart.type = 'button';
      cancel.type = 'button';
      actions.append(cancel, restart);
      dialog.append(actions);
      overlay.append(dialog);

      let busy = false;
      const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        onClose?.();
      };
      const onKey = (event) => { if (event.key === 'Escape' && !busy) close(); };

      overlay.addEventListener('click', () => { if (!busy) close(); });
      dialog.addEventListener('click', (event) => event.stopPropagation());
      cancel.addEventListener('click', () => { if (!busy) close(); });
      restart.addEventListener('click', async () => {
        busy = true;
        restart.disabled = true;
        cancel.disabled = true;
        restart.textContent = LOCALE.restarting;
        if (sessionId) {
          try { window.localStorage.setItem('hsb-restart:session', sessionId); } catch { /* storage off */ }
        }
        try {
          await post('/restart', { continue: box.checked, sessionId: sessionId ?? null });
        } catch { /* the app is about to restart anyway */ }
        close();
      });

      document.addEventListener('keydown', onKey);
      document.body.append(overlay);
      restart.focus();
    };

    const PowerIcon = () => h('svg', {
      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
    },
    h('path', { d: 'M8 2.2v5.2' }),
    h('path', { d: 'M4.4 4.2a5.1 5.1 0 1 0 7.2 0' }));

    function RestartButton(props) {
      ensureStyles();
      const slotSession = props?.sessionId ?? props?.session?.id ?? null;
      return h('button', {
        className: 'hr-footer-button',
        title: LOCALE.tooltip,
        'aria-label': LOCALE.tooltip,
        onClick: () => openDialog({ sessionId: slotSession ?? lastSessionId(), onClose: () => {} }),
      }, h(PowerIcon));
    }

    const lastSessionId = () => {
      try { return window.localStorage.getItem('hsb-restart:session') ?? null; } catch { return null; }
    };

    /** After a restart with "continue", reopen the session and submit the text. */
    const resumeAfterRestart = async (uiWorkspace) => {
      let pending = null;
      try {
        const response = await fetch(`${base}/pending`);
        if (!response.ok) return;
        pending = (await response.json())?.pending ?? null;
      } catch {
        return;
      }
      diag('boot', { pending, hasWorkspace: Boolean(uiWorkspace) });
      if (!pending || pending.continue !== true) return;
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
        const result = await submitContinue();
        diag('submit', result);
        if (result.ok) {
          await post('/consumed', {});
          return;
        }
      }
      diag('gave-up', {});
    };

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
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'restart',
            order: 90,
          }, RestartButton));
        } catch (error) {
          console.warn('hsb-restart: footer slot failed', error);
        }
        // A visible fallback near the composer: the sidebar footer collapses on
        // narrow windows, the composer dock does not.
        try {
          ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'restart',
            order: 95,
          }, RestartButton));
        } catch (error) {
          console.warn('hsb-restart: dock slot failed', error);
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
