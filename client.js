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
        language: 'Language',
        languageHint: 'Auto follows the application language',
        auto: 'Auto',
        languageRu: 'Русский',
        languageEn: 'English',
        languageZh: '中文',
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
        language: 'Язык',
        languageHint: 'Авто — по языку приложения',
        auto: 'Авто',
        languageRu: 'Русский',
        languageEn: 'English',
        languageZh: '中文',
      },
      zh: {
        title: '重新启动 DeepSeek Harness？',
        text: '应用将关闭并重新启动。正在进行的对话轮次会被中断。',
        keep: '重启后继续当前会话',
        cancel: '取消',
        restart: '重新启动',
        restarting: '正在重新启动…',
        tooltip: '重新启动 DeepSeek Harness',
        rowLabel: '重新启动 DeepSeek Harness',
        failed: '无法重新启动',
        toolEnabled: '代理可调用 dsh_restart',
        toolEnabledHint: '关闭后该工具会消失，调用将会失败',
        watchdog: '看门狗已启用',
        watchdogHint: '应用未能恢复时回滚配置',
        seconds: '看门狗等待时间，秒',
        secondsHint: '1–120',
        save: '保存',
        saved: '已保存',
        unavailable: '设置服务不可用',
        saveFailed: '无法保存',
        loading: '正在加载设置…',
        language: '语言',
        languageHint: '自动 — 跟随应用语言',
        auto: '自动',
        languageRu: 'Русский',
        languageEn: 'English',
        languageZh: '中文',
      },
    };

    const LANGUAGES = ['ru', 'en', 'zh', 'auto'];
    const DEFAULT_LANGUAGE = 'ru';

    /** The application language an unset or 'auto' preference follows. */
    const detectLanguage = () => {
      const raw = String(
        (typeof document === 'undefined' ? '' : document.documentElement?.lang)
        || (typeof navigator === 'undefined' ? '' : navigator.language)
        || 'en',
      ).toLowerCase();
      if (raw.startsWith('ru')) return 'ru';
      if (raw.startsWith('zh')) return 'zh';
      return 'en';
    };

    /**
     * Shared resolution order: an explicit setting, then 'auto' (the document
     * language, then the browser language), then the convention default ru.
     */
    const resolveLanguage = (settings) => {
      const preference = settings?.language;
      if (preference === 'ru' || preference === 'en' || preference === 'zh') return preference;
      if (preference === 'auto') return detectLanguage();
      return DEFAULT_LANGUAGE;
    };

    /** The language currently rendered; saved settings load asynchronously. */
    let uiLanguage = DEFAULT_LANGUAGE;
    const languageListeners = new Set();

    const applySettings = (values) => {
      const next = resolveLanguage(values);
      if (next === uiLanguage) return;
      uiLanguage = next;
      for (const listener of languageListeners) {
        try { listener(uiLanguage); } catch { /* a listener must not break the switch */ }
      }
    };

    const PORT = 49233;
    const base = `http://127.0.0.1:${PORT}`;
    // The token after the dot makes a duplicated or lost continuation traceable
    // in the chat itself, not only in restart.log.
    const CONTINUE_TEXT = '[auto.continue]';
    const FAILED_TEXT = '[auto.continue.failed]';
    const continuationText = (failed, token) => {
      const suffix = typeof token === 'string' && token !== '' ? `.${token}` : '';
      return failed ? `[auto.continue.failed${suffix}]` : `[auto.continue${suffix}]`;
    };

    const readSettings = async () => {
      const response = await fetch(`${base}/settings`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };

    /** Retry while the host bridge is still starting, then give up. */
    const loadSettingsData = async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          return await readSettings();
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
      throw lastError ?? new Error('settings unavailable');
    };

    let languagePromise = null;
    const ensureLanguage = () => {
      if (languagePromise === null) {
        languagePromise = loadSettingsData()
          .then((data) => { applySettings(data?.values); return data; });
        languagePromise.catch(() => { languagePromise = null; });
      }
      return languagePromise;
    };

    /** Subscribe a component to the language stored in the plugin settings. */
    const useUiLanguage = () => {
      const [language, setLanguage] = React.useState(uiLanguage);
      React.useEffect(() => {
        let alive = true;
        const listener = (next) => { if (alive) setLanguage(next); };
        languageListeners.add(listener);
        listener(uiLanguage);
        ensureLanguage().catch(() => { /* no setting: the default ru stays */ });
        return () => {
          alive = false;
          languageListeners.delete(listener);
        };
      }, []);
      return language;
    };

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
.hr-set-select { height: 32px; min-width: 132px; padding: 0 10px; border: 1px solid #dcdcdc; border-radius: 10px;
  background: #fff; color: inherit; font: inherit; outline: none; box-sizing: border-box; cursor: pointer; }
.hr-set-select:focus { border-color: #9a9a9a; }
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

      // One method per attempt, and at most three attempts: the old loop clicked
      // up to twelve times and then pressed Enter, which could post the same
      // continuation twice when the composer cleared slowly.
      let clicked = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const send = findSendButton();
        if (send !== undefined && !send.disabled) {
          clicked = true;
          send.click();
          diag('send-attempt', { attempt, via: 'button', text: markerText });
        } else {
          diag('send-attempt', { attempt, via: 'button-missing' });
        }
        for (let tick = 0; tick < 10; tick++) {
          await sleep(200);
          if (editorText(area) === '') {
            restoreDraft();
            return { ok: true, via: 'button', draftKept: draft !== '' };
          }
          if (editorText(area) !== markerText) break;
        }
        if (editorText(area) === '') {
          restoreDraft();
          return { ok: true, via: 'button', draftKept: draft !== '' };
        }
        if (editorText(area) !== markerText) break;
      }

      // Enter only when no click was ever sent: mixing the two is what makes a
      // duplicate possible.
      if (!clicked && editorText(area) === markerText) {
        diag('send-attempt', { attempt: 1, via: 'enter', text: markerText });
        const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        area.dispatchEvent(new KeyboardEvent('keydown', key));
        area.dispatchEvent(new KeyboardEvent('keyup', key));
        for (let tick = 0; tick < 10; tick++) {
          await sleep(200);
          if (editorText(area) === '') {
            restoreDraft();
            return { ok: true, via: 'enter', draftKept: draft !== '' };
          }
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

    function RestartButton(props) {
      ensureStyles();
      const language = useUiLanguage();
      const strings = STRINGS[language] ?? STRINGS[DEFAULT_LANGUAGE];
      const slotSession = props?.sessionId ?? props?.session?.id ?? null;
      return h('button', {
        className: 'hr-footer-button',
        title: strings.tooltip,
        'aria-label': strings.tooltip,
        onClick: () => openDialog({ sessionId: slotSession ?? lastSessionId(), strings, onClose: () => {} }),
      },
        h('span', { className: 'hr-footer-icon' }, h(PowerIcon)),
        h('span', { className: 'hr-footer-label' }, strings.rowLabel),
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
      let recovered = false;
      try {
        const response = await fetch(`${base}/claim`);
        if (!response.ok) return;
        const claimed = await response.json();
        pending = claimed?.marker ?? null;
        queued = claimed?.queued === true;
        failed = claimed?.failed === true;
        recovered = claimed?.recovered === true;
      } catch {
        return;
      }
      if (failed) pending = { ...(pending ?? {}), failed: true, recovered };
      // A pending queue keeps its messages: no marker is posted for it.
      if (queued) {
        diag('skip-queued', {});
        return;
      }
      diag('boot', { pending, hasWorkspace: Boolean(uiWorkspace) });
      if (!pending || pending.continue !== true) return;
      pending = { ...pending, failed };
      // At most one continuation per restart token, even across page reloads: a
      // reload between the submit and `/consumed` used to deliver it twice.
      const submittedKey = pending.token ? `dsh-restart:submitted:${pending.token}` : null;
      if (submittedKey !== null) {
        try {
          if (window.localStorage.getItem(submittedKey) === '1') {
            diag('already-submitted', { token: pending.token });
            try { await fetch(`${base}/consumed`, { method: 'POST' }); } catch { /* the bridge may be gone */ }
            return;
          }
        } catch {
          // A blocked storage must not block the continuation.
        }
      }
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
      for (const delay of [800, 1500, 3000, 6000, 10000]) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        const failedText = pending.failed === true && pending.recovered !== true;
        const result = await submitContinue(continuationText(failedText, pending.token));
        diag('submit', result);
        if (result.ok) {
          // The marker is retired only now: a boot without a composer keeps it
          // so the retry after a recovery can still deliver the message.
          if (submittedKey !== null) {
            try { window.localStorage.setItem(submittedKey, '1'); } catch { /* storage may be blocked */ }
          }
          try { await fetch(`${base}/consumed`, { method: 'POST' }); } catch { /* the bridge may be gone */ }
          return;
        }
      }
      diag('gave-up', {});
      // Keep the marker for a later boot, but let another page load claim it.
      try { await fetch(`${base}/claim/release`, { method: 'POST' }); } catch { /* the bridge may be down */ }
    };

    function SettingsForm() {
      ensureStyles();
      const [state, setState] = React.useState({ status: 'loading', values: {} });
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState({ text: '', error: false });

      React.useEffect(() => {
        let alive = true;
        loadSettingsData()
          .then((data) => {
            if (!alive) return;
            const values = data?.values ?? {};
            applySettings(values);
            setState({ status: 'ready', values });
          })
          .catch(() => { if (alive) setState({ status: 'error', values: {} }); });
        return () => { alive = false; };
      }, []);

      const setValue = (key, value) => {
        setState((current) => ({ ...current, values: { ...current.values, [key]: value } }));
      };

      const values = state.values ?? {};
      const strings = STRINGS[resolveLanguage(values)] ?? STRINGS[DEFAULT_LANGUAGE];

      const save = async () => {
        setSaving(true);
        setNotice({ text: '', error: false });
        try {
          const response = await fetch(`${base}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(state.values),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
          const nextValues = data.values ?? state.values;
          applySettings(nextValues);
          setState({ status: 'ready', values: nextValues });
          const savedStrings = STRINGS[resolveLanguage(nextValues)] ?? STRINGS[DEFAULT_LANGUAGE];
          setNotice({ text: savedStrings.saved, error: false });
        } catch (error) {
          const failedStrings = STRINGS[resolveLanguage(state.values)] ?? STRINGS[DEFAULT_LANGUAGE];
          setNotice({ text: `${failedStrings.saveFailed}: ${String(error?.message ?? error)}`, error: true });
        } finally {
          setSaving(false);
        }
      };

      if (state.status === 'loading') {
        return h('div', { className: 'hr-set', style: { color: '#8a8a8a' } }, strings.loading);
      }
      if (state.status === 'error') {
        return h('div', { className: 'hr-set', style: { color: '#c0392b' } }, strings.unavailable);
      }

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
      const selectedLanguage = LANGUAGES.includes(values.language) ? values.language : DEFAULT_LANGUAGE;
      const languageOptions = [
        ['ru', strings.languageRu],
        ['en', strings.languageEn],
        ['zh', strings.languageZh],
        ['auto', strings.auto],
      ];

      return h('div', { className: 'hr-set' },
        row(strings.language, h('select', {
          className: 'hr-set-select',
          value: selectedLanguage,
          onChange: (event) => setValue('language', event.target.value),
        }, languageOptions.map(([value, label]) => h('option', { key: value, value }, label))), strings.languageHint),
        row(strings.toolEnabled, toggle('toolEnabled', values.toolEnabled !== false), strings.toolEnabledHint),
        row(strings.watchdog, toggle('watchdogEnabled', values.watchdogEnabled !== false), strings.watchdogHint),
        row(strings.seconds, h('input', {
          type: 'number',
          min: 1,
          max: 120,
          className: 'hr-set-input',
          value: values.watchdogSeconds ?? 45,
          disabled: values.watchdogEnabled === false,
          onChange: (event) => setValue('watchdogSeconds', Number(event.target.value)),
        }), strings.secondsHint),
        h('div', { className: 'hr-set-actions' },
          h('button', { className: 'hr-set-save', disabled: saving, onClick: save }, strings.save),
          notice.text ? h('span', { className: `hr-set-status${notice.error ? ' hr-set-status--error' : ''}` }, notice.text) : null,
        ),
      );
    }

    /**
     * Report renderer failures with an attributed plugin id.
     *
     * The host already sees "entry did not activate" at boot; this covers the
     * other half — a plugin that mounts and then throws. The plugin id is taken
     * from the client bundle path in the stack, which is the only stable marker
     * the module loader leaves behind.
     */
    const installRecoveryReports = () => {
      if (window.__dshRestartRecoveryReports) return;
      window.__dshRestartRecoveryReports = true;
      const attribution = (value) => {
        const text = String(value?.stack ?? value?.message ?? value ?? '');
        const match = text.match(/(@deepseek-ai\/[a-z0-9.-]+|dsh-[a-z0-9-]+)\/client\.js/iu);
        return match ? match[1] : null;
      };
      const push = (plugin, message) => {
        try {
          void fetch(`${base}/errors`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [{ plugin, message, at: new Date().toISOString() }] }),
          });
        } catch {
          // The bridge may be down during a restart.
        }
      };
      window.addEventListener('error', (event) => {
        const value = event?.error ?? event?.message;
        if (!value) return;
        // Layout noise, not a plugin failure.
        if (/ResizeObserver loop/i.test(String(event?.message ?? ''))) return;
        push(attribution(value), String(event?.message ?? value?.message ?? 'error'));
      });
      window.addEventListener('unhandledrejection', (event) => {
        const value = event?.reason;
        if (!value) return;
        push(attribution(value), String(value?.message ?? value));
      });
    };

    const RECOVERY_TEXT = {
      en: {
        title: 'The previous start was recovered automatically',
        off: 'disabled',
        safe: 'Safe mode: only the base extensions are on',
        restore: 'Bring back',
        dismiss: 'Hide',
        restart: 'restart the app to apply',
      },
      ru: {
        title: 'Прошлый запуск восстановлен автоматически',
        off: 'отключены',
        safe: 'Безопасный режим: включены только базовые расширения',
        restore: 'Вернуть',
        dismiss: 'Скрыть',
        restart: 'перезапустите приложение, чтобы применить',
      },
      zh: {
        title: '上次启动已自动恢复',
        off: '已禁用',
        safe: '安全模式：仅启用基础扩展',
        restore: '恢复',
        dismiss: '隐藏',
        restart: '重启应用以生效',
      },
    };

    const recoveryLanguage = (saved) => {
      if (saved === 'ru' || saved === 'en' || saved === 'zh') return saved;
      const raw = String(document.documentElement?.lang || navigator.language || 'ru').toLowerCase();
      if (raw.startsWith('ru')) return 'ru';
      if (raw.startsWith('zh')) return 'zh';
      return 'en';
    };

    /** The saved interface language of this plugin, so the banner follows it. */
    const savedLanguage = async () => {
      try {
        const response = await fetch(`${base}/settings`, { cache: 'no-store' });
        if (!response.ok) return null;
        const data = await response.json();
        const language = data?.values?.language;
        return language === 'auto' ? null : (language ?? null);
      } catch {
        return null;
      }
    };

    /**
     * A banner after an automatic recovery: what was disabled, and the two
     * actions that matter — bring the extensions back or hide the notice.
     */
    const showRecoveryBanner = async () => {
      let data = null;
      try {
        const response = await fetch(`${base}/failed`, { cache: 'no-store' });
        if (!response.ok) return;
        data = await response.json();
      } catch {
        return;
      }
      const quarantine = data?.quarantine?.entries ?? [];
      const safeMode = data?.safeMode;
      const failed = data?.failed;
      if (!failed && quarantine.length === 0 && safeMode?.active !== true) return;
      if (document.querySelector('.hr-recovery') !== null) return;

      const strings = RECOVERY_TEXT[recoveryLanguage(await savedLanguage())] ?? RECOVERY_TEXT.en;
      const names = quarantine.map((entry) => entry.name).filter((name) => typeof name === 'string');
      if (document.querySelector('style[data-plugin="dsh-restart-recovery"]') === null) {
        const style = document.createElement('style');
        style.dataset.plugin = 'dsh-restart-recovery';
        style.textContent = `
.hr-recovery { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 3900;
  display: flex; align-items: center; gap: 14px; max-width: min(760px, calc(100vw - 48px));
  padding: 10px 12px 10px 16px; border-radius: 14px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  background: var(--dsw-alias-bg-l1, #fff); color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 13px; line-height: 18px; box-shadow: 0 2px 10px rgba(0, 0, 0, .12); }
.hr-recovery-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.hr-recovery-actions { display: flex; flex: none; gap: 8px; }
.hr-recovery-btn { height: 28px; padding: 0 12px; border-radius: 9px; border: .5px solid transparent;
  background: var(--dsw-alias-label-primary, #0f1115); color: #fff; font: inherit; font-size: 12px;
  cursor: pointer; }
.hr-recovery-btn--ghost { background: transparent; border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, .16));
  color: var(--dsw-alias-label-primary, #0f1115); }
`;
        document.head.appendChild(style);
      }
      const host = document.createElement('div');
      host.className = 'hr-recovery';
      host.dataset.plugin = 'dsh-restart';

      const text = document.createElement('div');
      text.className = 'hr-recovery-text';
      const reason = safeMode?.active === true
        ? strings.safe
        : `${strings.off}: ${names.join(', ') || '—'}`;
      text.textContent = `${strings.title} · ${reason}`;
      host.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'hr-recovery-actions';

      if (names.length > 0 || safeMode?.active === true) {
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'hr-recovery-btn';
        restore.textContent = strings.restore;
        restore.addEventListener('click', async () => {
          const path = safeMode?.active === true ? '/safe-mode/restore' : '/quarantine/restore';
          try {
            const response = await fetch(`${base}${path}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: null }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
            text.textContent = `${strings.restore}: ${strings.restart}`;
            restore.remove();
          } catch (error) {
            text.textContent = String(error?.message ?? error);
          }
        });
        actions.appendChild(restore);
      }

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'hr-recovery-btn hr-recovery-btn--ghost';
      dismiss.textContent = strings.dismiss;
      dismiss.addEventListener('click', async () => {
        try {
          await fetch(`${base}/failed/dismiss`, { method: 'POST' });
        } catch {
          // Hiding is local anyway.
        }
        host.remove();
      });
      actions.appendChild(dismiss);
      host.appendChild(actions);
      document.body.appendChild(host);
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
        installRecoveryReports();
        try { void fetch(`${base}/client-loaded`); } catch { /* bridge may be down */ }
        try {
          applyInner(ctx, report);
        } catch (error) {
          // A broken plugin must not fail the whole web boot: report and stay inert.
          report('apply-crashed', error);
        }
        setTimeout(() => { void showRecoveryBanner(); }, 2600);
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
