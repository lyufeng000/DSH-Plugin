window.__ModuleLoader__.load({
  id: 'dsh-live-model-probe',
  factory: () => {
    // Native operations read this getter synchronously from onClick. Never turn
    // normal discovery (including mount effects) into vendor network requests.
    function hookRefresh(remote, connection) {
      const service = remote?.llm;
      const previous = service && Object.getOwnPropertyDescriptor(service, 'discoverModels');
      let depth = 0, active = true, result, lastRequest = {};
      const controller = new AbortController();
      if (!previous?.configurable || !connection?.rpc?.call) return { run: source => source.click(), refreshQuiet: null, checkStatus: null, dispose() {} };
      const safeRequest = payload => payload && typeof payload === 'object' ? {
        ...(typeof payload.provider === 'string' ? { provider: payload.provider } : {}),
        ...(typeof payload.api === 'string' ? { api: payload.api } : {}),
        ...(typeof payload.baseURL === 'string' ? { baseURL: payload.baseURL } : {})
      } : {};
      const getter = function () {
        // Keep Cordis' caller-context getter intact; do not cache its function.
        const original = previous.get ? previous.get.call(this) : previous.value;
        return (...args) => {
          if (args[0] === 'llm-pi-ai' && args[1] && typeof args[1] === 'object') lastRequest = safeRequest(args[1]);
          if (!active || depth === 0 || args[0] !== 'llm-pi-ai') return original(...args);
          return result = (async () => {
            try { return await connection.rpc.call('/api', 'model-probe/refreshDiscovery', args[1] ?? {}, controller.signal); }
            catch { return { ok: false, error: { code: 'gateway/internal', message: '刷新失败，请检查网络连接。', details: {} } }; }
          })();
        };
      };
      Object.defineProperty(service, 'discoverModels', { configurable: true, enumerable: previous.enumerable, get: getter });
      const mergeRequest = payload => {
        const req = payload && typeof payload === 'object' ? { ...payload } : {};
        const isAdd = Boolean(req.__isAdd);
        delete req.__isAdd;
        if (!Object.keys(req).length) return isAdd ? {} : lastRequest;
        if (!isAdd && (!req.provider || req.provider === lastRequest.provider)) return { ...lastRequest, ...req };
        return req;
      };
      return {
        run(source) { result = undefined; depth++; try { source.click(); return result; } finally { depth--; } },
        async refreshQuiet(payload = {}) {
          if (!active) return { ok: false, error: { code: 'DISPOSED', message: '插件已停用。' } };
          try { return await connection.rpc.call('/api', 'model-probe/refreshDiscovery', mergeRequest(payload), controller.signal); }
          catch { return { ok: false, error: { code: 'gateway/internal', message: '刷新失败，请检查网络连接。', details: {} } }; }
        },
        async checkStatus(payload = {}) {
          if (!active) return { status: 'idle', newCount: 0 };
          try {
            const response = await connection.rpc.call('/api', 'model-probe/discoveryStatus', mergeRequest(payload), controller.signal);
            return response?.ok && response.value ? response.value : { status: 'idle', newCount: 0 };
          } catch { return { status: 'idle', newCount: 0 }; }
        },
        dispose() {
          active = false; controller.abort();
          if (Object.getOwnPropertyDescriptor(service, 'discoverModels')?.get === getter) Object.defineProperty(service, 'discoverModels', previous);
        }
      };
    }
    function mountPickerRefresh(doc, runRefresh = source => source.click(), previousOwner = null, checkStatus = null, refreshQuiet = null) {
      const win = doc.defaultView, marker = 'data-model-probe-picker-refresh';
      const SOURCES = new Set(['获取可用模型', 'Fetch available models', '利用可能なモデルを取得', 'Buscar modelos disponibles', 'Récupérer les modèles disponibles', 'Verfügbare Modelle abrufen', 'Получить доступные модели', 'Buscar modelos disponíveis']);
      const LEGACY_TITLES = new Set(['选择要添加的模型', 'Choose models to add']);
      const TITLES = new Set(['选择模型', 'Choose models', 'モデルを選択', 'Elige modelos', 'Choisir des modèles', 'Wählen Sie Modelle', 'Выберите модели', 'Escolha modelos', ...LEGACY_TITLES]);
      const DESELECT_ALL = new Set(['取消全选', 'Deselect all', 'すべて解除', 'Deseleccionar todo', 'Tout désélectionner', 'Alle abwählen', 'Отменить выбор всех', 'Desmarcar tudo']);
      const SELECT_ALL = new Set(['全选', 'Select all', 'すべて選択', 'Seleccionar todo', 'Tout sélectionner', 'Alles auswählen', 'Выбрать все', 'Selecionar tudo']);
      const entries = new Map();
      let owner = previousOwner, disposed = false, queued = false;
      const text = element => element?.textContent?.trim() ?? '';
      const isSource = button => SOURCES.has(text(button));
      const rows = dialog => [...(dialog?.querySelectorAll('li label') ?? [])].map(label => ({
        id: text(label.querySelector('span')), checkbox: label.querySelector('input[type="checkbox"]')
      })).filter(row => row.id && row.checkbox);
      const snapshot = entry => { for (const row of rows(entry.dialog)) entry.selections.set(row.id, row.checkbox.checked); };
      const schedule = () => {
        if (queued || disposed) return;
        queued = true; win.queueMicrotask(() => { queued = false; if (!disposed) scan(); });
      };
      const entryFor = event => {
        const dialog = event.target?.closest?.('[role="dialog"]');
        return [...entries.values()].find(entry => dialog && entry.dialog === dialog);
      };
      const remember = event => {
        const button = event.target?.closest?.('button');
        if (button && isSource(button)) owner = button;
        const entry = entryFor(event);
        if (entry && !entry.restoring && DESELECT_ALL.has(text(button))) {
          // Legacy 0.2.1 cleared the entire Set; 0.2.2-rc.3 only flips visible rows.
          const legacy = LEGACY_TITLES.has(text(entry.dialog?.querySelector('h1,h2,h3,[data-dialog-title]')));
          if (legacy) for (const id of entry.selections.keys()) entry.selections.set(id, false);
          else for (const row of rows(entry.dialog)) entry.selections.set(row.id, false);
        } else if (entry && !entry.restoring && SELECT_ALL.has(text(button))) {
          for (const row of rows(entry.dialog)) entry.selections.set(row.id, true);
        }
      };
      const rememberChoice = event => {
        const entry = entryFor(event);
        if (!entry || entry.restoring || event.target?.type !== 'checkbox') return;
        const id = text(event.target.closest('label')?.querySelector('span'));
        if (id) entry.selections.set(id, event.target.checked);
      };
      const rememberQuery = event => {
        const entry = entryFor(event);
        if (entry && !entry.restoring && event.target?.type === 'search') entry.query = event.target.value;
      };
      const inferRequest = source => {
        let card = source?.closest?.('[class*="addPanel"], li, [class*="rowCard"], [class*="addCard"]');
        if (!card) {
          let node = source?.parentElement;
          while (node && node !== doc.body) {
            if (node.tagName === 'LI' || /addPanel|addCard|rowCard|section/i.test(String(node.className ?? ''))) { card = node; break; }
            node = node.parentElement;
          }
          card ??= source?.parentElement;
        }
        const isAdd = /addPanel|addCard/i.test(String(card?.className ?? '')) || /-(?:catalog|custom)-panel$/.test(String(card?.id ?? ''));
        const hint = card?.querySelector?.('[id$="-credential-hint"],[id$="-endpoint-hint"],[id$="-retry-failure"]');
        let provider = hint?.id ? hint.id.replace(/-(?:credential-hint|endpoint-hint|retry-failure)$/, '') : undefined;
        if (!provider) {
          for (const btn of card?.querySelectorAll?.('[class*="rowActions"] button[aria-label], button[aria-label]') ?? []) {
            const label = btn.getAttribute?.('aria-label') ?? '';
            const match = /\(([a-z0-9][a-z0-9-]*)\)\s*$/i.exec(label);
            if (match) { provider = match[1]; break; }
          }
        }
        const inputs = [...(card?.querySelectorAll?.('input') ?? [])];
        if (!provider) {
          const routeInput = inputs.find(el => /provider\s*id|提供商\s*id|プロバイダーid/i.test(el.getAttribute?.('aria-label') ?? ''));
          if (routeInput?.value?.trim()) provider = routeInput.value.trim();
        }
        const selects = [...(card?.querySelectorAll?.('select') ?? [])];
        const apiSelect = selects.find(el => /^(?:openai-completions|openai-responses|anthropic-messages|google-generative-ai|openrouter|azure-openai-responses|openai-codex-responses)$/.test(el.value ?? ''));
        if (!provider) {
          const providerSelect = selects.find(el => el !== apiSelect && /^(?:provider|提供商|プロバイダー|fournisseur|anbieter|поставщик|provedor|proveedor)$/i.test(el.getAttribute?.('aria-label') ?? ''))
            ?? selects.find(el => el !== apiSelect && /^[a-z0-9][a-z0-9-]*$/.test(el.value ?? '') && ![...(el.options ?? [])].some(opt => opt.value === 'default'));
          if (providerSelect?.value?.trim()) provider = providerSelect.value.trim();
        }
        const displayName = card?.querySelector?.('[class*="rowName"]')?.textContent?.trim() || undefined;
        if (!provider && displayName && /^[a-z0-9][a-z0-9-]*$/.test(displayName)) provider = displayName;
        const api = apiSelect?.value || undefined;
        const urlInput = inputs.find(el => el.type !== 'password' && (/url|地址/i.test(el.getAttribute?.('aria-label') ?? '') || /^https?:\/\//i.test(el.value?.trim() ?? '')));
        const baseURL = urlInput?.value?.trim() || undefined;
        const keyInput = inputs.find(el => el.type === 'password' || /api\s*key|密钥|key/i.test(el.getAttribute?.('aria-label') ?? ''));
        const apiKey = keyInput?.value?.trim() ? keyInput.value : undefined;
        return {
          ...(isAdd ? { __isAdd: true } : {}),
          ...(provider ? { provider } : {}),
          ...(!provider && displayName ? { displayName } : {}),
          ...(api ? { api } : {}),
          ...(baseURL ? { baseURL } : {}),
          ...(apiKey !== undefined ? { apiKey } : {})
        };
      };
      const failureLabel = error => {
        const map = {
          MISSING_CREDENTIAL: '失败：未配置密钥',
          MISSING_ENDPOINT: '失败：缺少服务地址',
          UNSUPPORTED_PROTOCOL: '失败：不支持协议',
          AZURE_DISCOVERY_UNSUPPORTED: '失败：不支持 Azure',
          ENDPOINT_CONFIRM_REQUIRED: '失败：地址未保存',
          NETWORK_ERROR: '失败：连接失败',
          TIMEOUT: '失败：请求超时',
          DISCOVERY_AUTH_FAILED: '失败：密钥无效'
        };
        return map[error?.code] || '刷新失败';
      };
      function pollQuietUpdates(entry, attempt = 0) {
        if (disposed || !checkStatus || !entry.dialog || entry.pending) return;
        win.clearTimeout(entry.pollTimer);
        checkStatus(inferRequest(entry.owner)).then(result => {
          if (disposed || !entry.dialog || entry.pending) return;
          const nextCount = Number(result?.newCount) > 0 ? Number(result.newCount) : 0;
          if (nextCount !== entry.newCount) {
            entry.newCount = nextCount;
            schedule();
          }
          if (result?.status === 'checking' && attempt < 30) {
            entry.pollTimer = win.setTimeout(() => pollQuietUpdates(entry, attempt + 1), 400);
          }
        }, () => {});
      }
      function create(source) {
        const button = doc.createElement('button');
        button.type = 'button'; button.setAttribute(marker, '');
        button.textContent = '刷新'; button.setAttribute('aria-label', '刷新模型列表');
        button.className = source.className; button.style.whiteSpace = 'nowrap'; button.style.flexShrink = '0';
        const entry = { button, owner: source, dialog: null, pending: false, restoring: false, selections: new Map(), query: '', timer: null, pollTimer: null, flashTimer: null, flashLabel: '', newCount: 0 };
        entries.set(source, entry);
        button.addEventListener('click', () => {
          if (entry.pending || !source.isConnected || source.disabled) return;
          win.clearTimeout(entry.pollTimer);
          win.clearTimeout(entry.flashTimer);
          entry.flashLabel = '';
          entry.newCount = 0;
          owner = source;
          if (!entry.dialog && refreshQuiet) {
            entry.pending = true;
            button.disabled = true; button.textContent = '刷新中…'; button.title = '正在后台刷新模型列表';
            refreshQuiet(inferRequest(source)).then(response => {
              if (disposed || !entries.has(source)) return;
              entry.pending = false;
              if (response?.ok) {
                const count = Array.isArray(response.value) ? response.value.length : 0;
                entry.flashLabel = `已刷新 (${count})`;
                button.title = `已更新模型列表（共 ${count} 个模型）`;
              } else {
                entry.flashLabel = failureLabel(response?.error);
                button.title = response?.error?.message || '刷新失败';
              }
              entry.flashTimer = win.setTimeout(() => { entry.flashLabel = ''; schedule(); }, 3000);
              schedule();
            }, () => {
              if (disposed || !entries.has(source)) return;
              entry.pending = false;
              entry.flashLabel = '失败：连接失败';
              button.title = '刷新失败，请检查网络连接。';
              entry.flashTimer = win.setTimeout(() => { entry.flashLabel = ''; schedule(); }, 3000);
              schedule();
            });
            schedule();
            return;
          }
          snapshot(entry); entry.query = entry.dialog?.querySelector('input[type="search"]')?.value ?? '';
          entry.pending = true; entry.sawBusy = false;
          button.disabled = true; button.textContent = '刷新中…'; button.title = '正在刷新模型列表';
          const finish = () => {
            if (disposed || !entries.has(source)) return;
            // Let native await/React commit finish before restoring controlled inputs.
            win.clearTimeout(entry.timer);
            entry.timer = win.setTimeout(() => { entry.settled = true; schedule(); }, 0);
          };
          const request = runRefresh(source);
          if (request?.then) request.then(finish, finish);
          schedule();
        });
        return entry;
      }
      function scan() {
        for (const [source, entry] of entries) if (!source.isConnected) {
          win.clearTimeout(entry.timer); win.clearTimeout(entry.pollTimer); win.clearTimeout(entry.flashTimer); entry.button.remove(); entries.delete(source);
        }
        for (const source of doc.querySelectorAll('button')) if (isSource(source) && !entries.has(source)) create(source);
        const dialog = [...doc.querySelectorAll('[role="dialog"]')].find(item => TITLES.has(text(item.querySelector('h1,h2,h3,[data-dialog-title]'))));
        for (const entry of entries.values()) {
          const nextDialog = entry.owner === owner ? dialog ?? null : null;
          if (entry.dialog !== nextDialog) {
            win.clearTimeout(entry.pollTimer);
            if (!entry.pending) { entry.selections.clear(); entry.query = ''; entry.newCount = 0; }
            entry.dialog = nextDialog;
            if (nextDialog && !entry.pending && checkStatus) pollQuietUpdates(entry);
          }
          const search = entry.dialog?.querySelector('input[type="search"]');
          const target = search?.parentElement ?? entry.owner.parentElement;
          if (target && entry.button.parentElement !== target) target.append(entry.button);
          if (search && target === search.parentElement) {
            if (search.style && !search.style.minWidth) search.style.minWidth = '0';
            for (const sibling of target.querySelectorAll?.('button') ?? []) if (sibling !== entry.button && sibling.style) {
              if (sibling.style.whiteSpace !== 'nowrap') sibling.style.whiteSpace = 'nowrap';
              if (sibling.style.flexShrink !== '0') sibling.style.flexShrink = '0';
            }
          }
          if (entry.pending) {
            entry.sawBusy ||= Boolean(entry.owner.disabled);
            if (!entry.owner.disabled && (entry.settled || entry.sawBusy)) {
              entry.pending = false; entry.settled = false; entry.restoring = true;
              win.clearTimeout(entry.timer);
              // Success resets the native filter to empty, so hidden old choices
              // are restored too. Failures leave the old list and query untouched.
              for (const row of rows(entry.dialog)) if (entry.selections.has(row.id) && row.checkbox.checked !== entry.selections.get(row.id)) row.checkbox.click();
              if (search && search.value !== entry.query) {
                Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(search, entry.query);
                search.dispatchEvent(new win.Event('input', { bubbles: true }));
              }
              const failure = entry.owner.closest('section')?.querySelector('p[class*="error"]');
              entry.button.title = text(failure) || '已重新获取；原有勾选已保留，未添加或保存模型。';
              entry.timer = win.setTimeout(() => { entry.restoring = false; schedule(); }, 0);
            }
          } else if (!entry.restoring) snapshot(entry);
          const disabled = entry.pending || Boolean(entry.owner.disabled);
          if (entry.button.disabled !== disabled) entry.button.disabled = disabled;
          const label = entry.pending ? '刷新中…' : entry.newCount > 0 ? `发现 ${entry.newCount} 个新模型 · 刷新` : entry.flashLabel || '刷新';
          if (entry.button.textContent !== label) entry.button.textContent = label;
          if (!entry.pending && entry.newCount > 0) {
            entry.button.title = `检测到 ${entry.newCount} 个新模型，点击刷新列表`;
            entry.button.style.color = '#60a5fa';
          } else if (!entry.pending) {
            if (entry.button.style.color) entry.button.style.color = '';
          }
        }
      }
      doc.addEventListener('click', remember, true); doc.addEventListener('change', rememberChoice, true); doc.addEventListener('input', rememberQuery, true);
      const observer = new win.MutationObserver(schedule);
      observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
      scan();
      return () => {
        disposed = true; observer.disconnect();
        doc.removeEventListener('click', remember, true); doc.removeEventListener('change', rememberChoice, true); doc.removeEventListener('input', rememberQuery, true);
        for (const entry of entries.values()) { win.clearTimeout(entry.timer); win.clearTimeout(entry.pollTimer); win.clearTimeout(entry.flashTimer); entry.button.remove(); }
        entries.clear();
        return owner;
      };
    }
    return {
      inject: ['remote', 'remote.llm', 'connection'],
      mountPickerRefresh, hookRefresh,
      apply(ctx) {
        ctx.effect(() => {
          const previousOwner = window.__modelProbePickerDispose?.();
          const refresh = hookRefresh(ctx.remote, ctx.get?.('connection'));
          const unmount = mountPickerRefresh(document, refresh.run, previousOwner, refresh.checkStatus, refresh.refreshQuiet);
          const dispose = () => { const source = unmount(); refresh.dispose(); return source; };
          window.__modelProbePickerDispose = dispose;
          return () => { dispose(); if (window.__modelProbePickerDispose === dispose) delete window.__modelProbePickerDispose; };
        });
      }
    };
  }
});
