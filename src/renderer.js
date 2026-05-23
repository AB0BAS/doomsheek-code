const $ = (id) => document.getElementById(id);

const state = {
  providers: {},
  settings: { keys: {}, extras: {}, lastProvider: 'openai', lastModel: 'gpt-4o-mini', lastDir: null },
  rootDir: null,
  openFiles: new Map(),
  activeFile: null,
  editor: null,
  monaco: null,
  messages: [],
  currentStreamId: null,
  currentAssistantEl: null,
  attachments: [],
  terminal: null,
  termFit: null,
  termId: null,
  termSubs: null,
  fileList: [],
  paletteMode: null,
  paletteItems: [],
  paletteSelected: 0,
  chatId: null,
  chatTitle: 'Новый чат',
  chatPersistTimer: null,
  agentMode: false,
  agentBusy: false,
  agentStopped: false,
  agentCwd: null,
  memory: [],
  webSearch: false,
  streamHandledLocally: false,
  contextFiles: [],
  agentChanges: []
};
let toastTimer = null;

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', html: 'html', css: 'css', scss: 'scss', less: 'less',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'shell', bash: 'shell', ps1: 'powershell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  md: 'markdown', markdown: 'markdown', xml: 'xml', sql: 'sql',
  vue: 'html', svelte: 'html'
};

function langForFile(name) {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  const ext = lower.split('.').pop();
  return LANG_BY_EXT[ext] || 'plaintext';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMarkdown(text) {
  const blocks = [];
  // ``` fenced blocks (полные, с закрывающим ```)
  let s = String(text || '').replace(/```([\w+#-]*)\r?\n([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push({ lang: (lang || '').toLowerCase(), code });
    return '\x00B' + (blocks.length - 1) + '\x00';
  });
  // Незакрытый блок в конце — для стриминга «на лету».
  s = s.replace(/```([\w+#-]*)\r?\n([\s\S]*)$/, (_m, lang, code) => {
    blocks.push({ lang: (lang || '').toLowerCase(), code, partial: true });
    return '\x00B' + (blocks.length - 1) + '\x00';
  });
  s = escapeHtml(s);
  // Заголовки # ## ### #### ##### ###### в начале строки.
  s = s.replace(/^(#{1,6})\s+(.+)$/gm, (_m, hashes, content) => {
    const n = hashes.length;
    return '<h' + n + ' class="md-h md-h' + n + '">' + content.trim() + '</h' + n + '>';
  });
  // Горизонтальная линия --- / *** / ___ на отдельной строке.
  s = s.replace(/^(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr class="md-hr">');
  // Списки построчно: подряд идущие "- item" или "1. item" в <ul>/<ol>.
  {
    const lines = s.split('\n');
    const out = [];
    let listType = null;
    const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };
    for (const line of lines) {
      const ul = line.match(/^[-*+]\s+(.+)$/);
      const ol = line.match(/^\d+\.\s+(.+)$/);
      if (ul) {
        if (listType !== 'ul') { closeList(); out.push('<ul class="md-list">'); listType = 'ul'; }
        out.push('<li>' + ul[1] + '</li>');
      } else if (ol) {
        if (listType !== 'ol') { closeList(); out.push('<ol class="md-list">'); listType = 'ol'; }
        out.push('<li>' + ol[1] + '</li>');
      } else {
        closeList();
        out.push(line);
      }
    }
    closeList();
    s = out.join('\n');
  }
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => '<code class="md-inline">' + c + '</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\x00B(\d+)\x00/g, (_m, i) => {
    const b = blocks[Number(i)];
    const langLabel = b.lang || 'code';
    const partial = b.partial ? ' partial' : '';
    return '<div class="md-codeblock' + partial + '">' +
      '<div class="md-cb-head">' +
        '<span class="md-cb-lang">' + escapeHtml(langLabel) + '</span>' +
        '<button class="md-cb-copy" title="Копировать">⧉</button>' +
      '</div>' +
      '<pre><code>' + escapeHtml(b.code) + '</code></pre>' +
    '</div>';
  });
  return s;
}

// Навешиваем поведение кнопок «копировать» внутри отрендеренного md.
function hookupMarkdown(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.md-cb-copy:not([data-bound])').forEach((btn) => {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const codeEl = btn.closest('.md-codeblock')?.querySelector('pre code');
      const code = codeEl?.textContent || '';
      try { await navigator.clipboard.writeText(code); } catch (_) {}
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '⧉'; }, 1200);
    });
  });
}

function getFileBadge(name = '') {
  const ext = name.toLowerCase().split('.').pop();
  const map = {
    js: 'JS',
    jsx: 'JS',
    ts: 'TS',
    tsx: 'TS',
    json: '{}',
    html: 'H',
    css: 'C',
    md: 'MD',
    java: 'J',
    py: 'PY',
    txt: 'TX'
  };
  return map[ext] || (name.slice(0, 2).toUpperCase() || 'FI');
}

function getChangeActionLabel(type) {
  if (type === 'create') return 'Создание файла';
  if (type === 'write') return 'Изменение файла';
  if (type === 'delete') return 'Удаление файла';
  return 'Изменение';
}

function computeChangeStats(change) {
  const oldText = change.oldContent == null ? '' : String(change.oldContent);
  const newText = change.newContent == null ? '' : String(change.newContent);

  if (change.lastType === 'create') {
    const added = newText ? newText.split(/\r?\n/).length : 0;
    return { added, removed: 0 };
  }
  if (change.lastType === 'delete') {
    const removed = oldText ? oldText.split(/\r?\n/).length : 0;
    return { added: 0, removed };
  }

  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  let added = 0;
  let removed = 0;
  const max = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < max; i++) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) continue;
    if (a !== undefined) removed++;
    if (b !== undefined) added++;
  }
  return { added, removed };
}

function buildPreviewLines(change) {
  const oldText = change.oldContent == null ? '' : String(change.oldContent);
  const newText = change.newContent == null ? '' : String(change.newContent);

  if (change.lastType === 'create') {
    return newText.split(/\r?\n/).slice(0, 8).map(line => ({ type: 'added', text: `+ ${line}` }));
  }
  if (change.lastType === 'delete') {
    return oldText.split(/\r?\n/).slice(0, 8).map(line => ({ type: 'removed', text: `- ${line}` }));
  }

  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const lines = [];
  const max = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < max && lines.length < 8; i++) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) {
      if (a !== undefined && lines.length < 2) lines.push({ type: 'neutral', text: `  ${a}` });
      continue;
    }
    if (a !== undefined) lines.push({ type: 'removed', text: `- ${a}` });
    if (b !== undefined && lines.length < 8) lines.push({ type: 'added', text: `+ ${b}` });
  }

  if (!lines.length) lines.push({ type: 'neutral', text: '  Нет предпросмотра' });
  return lines.slice(0, 8);
}

async function init() {
  state.providers = await window.app.listProviders();
  state.settings = await window.app.getSettings();
  state.agentMode = state.settings.agentMode !== false;
  try { state.memory = await window.app.memory.get() || []; } catch (_) { state.memory = []; }

  initProviderSelect();
  initEvents();
  // Лого Doomsheek code — клик открывает Telegram автора в системном браузере.
  $('app-logo')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.app.openExternal('https://t.me/Doomshk');
  });
  initActivityBar();
  initImageHandlers();
  initPalette();
  initChatHistory();
  initTerminalUI();
  initTopbarSearch();
  initAgentsPanel();
  initStickyMessage();
  initGithubTab();
  initInAppBrowser();
  initPanelResizers();
  applyAgentUI();
  updateChatCarousel().catch(() => {});
  await initMonaco();

  renderWelcome();
}

// ===== Перетаскиваемые ресайзеры между sidebar/editor и editor/chat. =====
function initPanelResizers() {
  const app = $('app');
  if (!app) return;
  // Применяем сохранённые ширины (если есть).
  const sw = Number(state.settings.layoutSidebarWidth) || 240;
  const cw = Number(state.settings.layoutChatWidth) || 380;
  applyPanelWidths(sw, cw);

  const setupResizer = (id, kind /* 'sidebar' | 'chat' */) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('dragging');
      const startX = e.clientX;
      const startSidebar = currentPanelWidth('sidebar');
      const startChat = currentPanelWidth('chat');
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        let s = startSidebar, c = startChat;
        if (kind === 'sidebar') s = clamp(startSidebar + dx, 140, Math.max(200, window.innerWidth - 600));
        else c = clamp(startChat - dx, 220, Math.max(260, window.innerWidth - 500));
        applyPanelWidths(s, c);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        el.classList.remove('dragging');
        state.settings.layoutSidebarWidth = currentPanelWidth('sidebar');
        state.settings.layoutChatWidth = currentPanelWidth('chat');
        window.app.setSettings(state.settings);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  };
  setupResizer('resizer-sidebar', 'sidebar');
  setupResizer('resizer-chat', 'chat');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function applyPanelWidths(sidebarW, chatW) {
  const app = $('app');
  if (!app) return;
  // Сохраняем как CSS-переменные, чтобы перебить только нужные колонки в grid-template-columns.
  app.style.setProperty('--sidebar-w', sidebarW + 'px');
  app.style.setProperty('--chat-w', chatW + 'px');
  // Базовое раскладочное правило с учётом ресайзеров. Если активен agents-open — добавится колонка.
  const agentsW = app.classList.contains('agents-open') ? ' 260px' : '';
  app.style.gridTemplateColumns = `44px ${sidebarW}px 4px 1fr 4px ${chatW}px${agentsW}`;
}

function currentPanelWidth(kind) {
  const app = $('app');
  if (!app) return kind === 'sidebar' ? 240 : 380;
  const tpl = app.style.gridTemplateColumns || '';
  const parts = tpl.trim().split(/\s+/);
  // parts: [activity, sidebar, rs1, editor, rs2, chat, (agents?)]
  if (kind === 'sidebar') return parseFloat(parts[1]) || currentSettingsWidth('sidebar');
  if (kind === 'chat')    return parseFloat(parts[5]) || currentSettingsWidth('chat');
  return 0;
}
function currentSettingsWidth(kind) {
  if (kind === 'sidebar') return Number(state.settings?.layoutSidebarWidth) || 240;
  if (kind === 'chat')    return Number(state.settings?.layoutChatWidth) || 380;
  return 0;
}

function applyAgentUI() {
  const ask = $('mode-ask');
  const agent = $('mode-agent');
  if (ask) ask.classList.toggle('active', !state.agentMode);
  if (agent) agent.classList.toggle('active', state.agentMode);
  const ci = $('chat-input');
  if (ci) ci.placeholder = state.agentMode
    ? 'Попросите ИИ что-нибудь сделать с файлами или кодом... (Ctrl+L — добавить контекст)'
    : 'Спросите что-нибудь... (Ctrl+L — добавить контекст)';
}

function renderWelcome() {
  const recent = (state.settings.recentDirs || []).slice(0, 10);
  const list = $('welcome-recent');
  list.innerHTML = '';
  if (recent.length === 0) {
    list.innerHTML = '<div class="recent-empty">Нет недавних папок</div>';
    return;
  }
  for (const dir of recent) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    item.innerHTML = `<div class="name">${escapeHtml(name)}</div><div class="path">${escapeHtml(dir)}</div><div class="actions"><button data-act="rm">Убрать</button></div>`;
    item.addEventListener('click', async (e) => {
      if (e.target.dataset?.act === 'rm') {
        state.settings.recentDirs = recent.filter(d => d !== dir);
        await window.app.setSettings(state.settings);
        renderWelcome();
        return;
      }
      await openDir(dir);
    });
    list.appendChild(item);
  }
}

async function pushRecentDir(dir) {
  state.settings.recentDirs = state.settings.recentDirs || [];
  state.settings.recentDirs = [dir, ...state.settings.recentDirs.filter(d => d !== dir)].slice(0, 10);
  await window.app.setSettings(state.settings);
}

function initProviderSelect() {
  const ps = $('provider-select');
  ps.innerHTML = '';
  for (const [id, p] of Object.entries(state.providers)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.name;
    ps.appendChild(opt);
  }
  ps.value = state.settings.lastProvider in state.providers ? state.settings.lastProvider : 'openai';
  ps.addEventListener('change', () => { updateModelSelect(); persistChoice(); });
  updateModelSelect();
}

function updateModelSelect() {
  const provId = $('provider-select').value;
  const ms = $('model-select');
  ms.innerHTML = '';
  const available = (state.settings.availableModels && state.settings.availableModels[provId]) || [];
  const defaults = state.providers[provId]?.models || [];
  state.settings.showAllModels = state.settings.showAllModels || {};
  const showAll = !!state.settings.showAllModels[provId];
  // Режим «расширенный» работает, только если есть полный список (после Проверки ключа).
  const canExpand = available.length > 0;
  const models = (showAll && canExpand) ? available : defaults;
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    ms.appendChild(opt);
  }
  // Тоггл «показать все/только курируемые».
  if (canExpand) {
    const toggleOpt = document.createElement('option');
    toggleOpt.value = '__toggle_all__';
    toggleOpt.textContent = showAll
      ? `▲ Скрыть расширенные (${available.length})`
      : `▼ Показать все модели (${available.length})`;
    ms.appendChild(toggleOpt);
  }
  const editOpt = document.createElement('option');
  editOpt.value = '__custom__';
  editOpt.textContent = '✎ Своя модель...';
  ms.appendChild(editOpt);
  if (state.settings.lastProvider === provId && models.includes(state.settings.lastModel)) {
    ms.value = state.settings.lastModel;
  }
  ms.onchange = () => {
    if (ms.value === '__toggle_all__') {
      state.settings.showAllModels[provId] = !showAll;
      window.app.setSettings(state.settings);
      updateModelSelect();
      return;
    }
    if (ms.value === '__custom__') {
      const custom = prompt('Введите имя модели:');
      if (custom) {
        const opt = document.createElement('option');
        opt.value = custom;
        opt.textContent = custom;
        ms.insertBefore(opt, editOpt);
        ms.value = custom;
      } else {
        ms.value = models[0] || '';
      }
    }
    persistChoice();
  };
}

function persistChoice() {
  state.settings.lastProvider = $('provider-select').value;
  state.settings.lastModel = $('model-select').value;
  window.app.setSettings(state.settings);
}

function initEvents() {
  $('btn-settings').addEventListener('click', openSettings);
  initMenuBar();
  initWindowControls();
  initTopbarToggles();
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-save').addEventListener('click', saveSettings);
  $('settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') closeSettings();
  });
  $('settings-check-all')?.addEventListener('click', async () => {
    for (const card of document.querySelectorAll('.provider-card')) {
      const id = card.dataset.providerId;
      const key = card.querySelector('.prov-key').value.trim();
      if (key) await checkProviderKey(id, card);
    }
  });
  $('btn-send').addEventListener('click', sendChat);
  $('ctx-gauge').addEventListener('click', () => {
    setStatus($('ctx-gauge').title || 'Память чата');
  });
  $('changes-review').addEventListener('click', reviewChanges);
  $('changes-keep').addEventListener('click', keepAllChanges);
  $('changes-undo').addEventListener('click', undoAllChanges);
  $('changes-close').addEventListener('click', () => $('changes-modal').classList.remove('open'));
  $('changes-modal-keep').addEventListener('click', () => {
    keepAllChanges();
    $('changes-modal').classList.remove('open');
  });
  $('changes-modal-undo').addEventListener('click', async () => {
    await undoAllChanges();
    $('changes-modal').classList.remove('open');
  });
  $('changes-modal').addEventListener('click', (e) => {
    if (e.target.id === 'changes-modal') $('changes-modal').classList.remove('open');
  });
}

function trackAgentChange(type, path, oldContent, newContent = null) {
  const existing = state.agentChanges.find(c => c.path === path);
  if (existing) {
    existing.lastType = type;
    if (existing.oldContent == null) existing.oldContent = oldContent;
    existing.newContent = newContent;
  } else {
    state.agentChanges.push({ type, path, oldContent, newContent, lastType: type });
  }
  updateChangesBar();
  if (state.rootDir && path.toLowerCase().startsWith(state.rootDir.toLowerCase())) {
    refreshTreeQuiet().catch(() => {});
  }
}

function updateChangesBar() {
  const bar = $('changes-bar');
  if (!bar) return;
  if (state.agentChanges.length === 0) {
    bar.classList.remove('open');
    return;
  }
  const created = state.agentChanges.filter(c => c.lastType === 'create').length;
  const modified = state.agentChanges.filter(c => c.lastType === 'write').length;
  const deleted = state.agentChanges.filter(c => c.lastType === 'delete').length;
  const parts = [];
  if (created) parts.push(`<span style="color:#56d364"><b>+${created}</b> создано</span>`);
  if (modified) parts.push(`<span style="color:#e2c08d"><b>~${modified}</b> изменено</span>`);
  if (deleted) parts.push(`<span style="color:#ff7b72"><b>−${deleted}</b> удалено</span>`);
  $('changes-label').innerHTML = parts.join(' · ');
  bar.classList.add('open');
}

function clearChangesBar() {
  state.agentChanges = [];
  updateChangesBar();
}

function reviewChanges() {
  if (state.agentChanges.length === 0) {
    setStatus('Нет изменений для просмотра');
    return;
  }
  renderChangesModal();
  $('changes-modal').classList.add('open');
}

function renderChangesModal() {
  const list = $('changes-list');
  if (!list) return;
  list.innerHTML = '';
  state.agentChanges.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'change-row';
    const name = c.path.split(/[\\/]/).pop();
    const stats = computeChangeStats(c);
    const previewLines = buildPreviewLines(c);
    row.innerHTML = `
      <div class="change-head">
        <span class="change-file-icon">${escapeHtml(getFileBadge(name))}</span>
        <div class="change-file-meta">
          <span class="change-file-name">${escapeHtml(name)}</span>
          <span class="change-file-action">${escapeHtml(getChangeActionLabel(c.lastType))}</span>
          <span class="change-file-path" title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</span>
        </div>
        <div class="change-stats">
          <span class="change-stat added">+${stats.added}</span>
          <span class="change-stat removed">−${stats.removed}</span>
          <span class="change-badge">ok</span>
        </div>
      </div>
      <div class="change-body">
        <pre class="change-diff">${previewLines.map(line => `<span class="change-diff-line ${line.type}">${escapeHtml(line.text)}</span>`).join('')}</pre>
      </div>
      <div class="change-actions">
        <button class="open-btn" data-act="open" data-idx="${idx}">Открыть</button>
        <button class="revert-btn" data-act="revert" data-idx="${idx}">Откатить</button>
      </div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      const c = state.agentChanges[idx];
      if (!c) return;
      if (btn.dataset.act === 'open') {
        if (c.lastType === 'delete') {
          setStatus('Файл удалён — нечего открывать');
          return;
        }
        await openFile(c.path, c.path.split(/[\\/]/).pop());
        $('changes-modal').classList.remove('open');
      } else if (btn.dataset.act === 'revert') {
        await revertOneChange(idx);
      }
    });
  });
}

async function revertOneChange(idx) {
  const c = state.agentChanges[idx];
  if (!c) return;
  try {
    if (c.lastType === 'create') {
      await window.app.rm(c.path);
    } else if ((c.lastType === 'write' || c.lastType === 'delete') && c.oldContent != null) {
      await window.app.writeAuto(c.path, c.oldContent);
    }
    state.agentChanges.splice(idx, 1);
    renderChangesModal();
    updateChangesBar();
    setStatus('Изменение откачено');
    if (state.agentChanges.length === 0) $('changes-modal').classList.remove('open');
    if (state.rootDir) refreshTreeQuiet();
  } catch (e) {
    setStatus('Ошибка отката: ' + (e?.message || e), 'error');
  }
}

async function refreshTreeQuiet() {
  if (!window.app.tree || !state.rootDir) return;
  const tree = await window.app.tree(state.rootDir, { showHidden: !!state.settings.showHidden });
  const treeEl = $('tree');
  if (!treeEl) return;
  treeEl.innerHTML = '';
  if (!tree) return;
  // Рисуем детей корня плоско, без самого корня (имя корня и так на explorer-title).
  const titleEl = $('explorer-title');
  if (titleEl) titleEl.textContent = tree.name || state.rootDir;
  if (Array.isArray(tree.children)) {
    for (const child of tree.children) treeEl.appendChild(renderTree(child, 0));
  }
  renderDeletedGhosts();
}

function renderDeletedGhosts() {
  const treeEl = $('tree');
  if (!treeEl) return;
  treeEl.querySelectorAll('.tree-deleted-section').forEach(el => el.remove());
  const deleted = state.agentChanges.filter(c => c.lastType === 'delete');
  if (deleted.length === 0) return;
  const section = document.createElement('div');
  section.className = 'tree-deleted-section';
  section.innerHTML = `<div class="tree-deleted-header">Удалено агентом (${deleted.length})</div>`;
  for (const c of deleted) {
    const row = document.createElement('div');
    row.className = 'tree-row deleted ghost';
    const name = c.path.split(/[\\/]/).pop();
    row.innerHTML = `
      <span class="indent" style="width:4px"></span>
      <span class="chevron hidden"></span>
      <span class="ficon file-default">×</span>
      <span class="name" title="${escapeHtml(c.path)}">${escapeHtml(name)}</span>
      <button class="ghost-restore" data-path="${escapeHtml(c.path)}" title="Восстановить">↺</button>`;
    row.querySelector('.ghost-restore').addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = state.agentChanges.findIndex(x => x.path === c.path);
      if (idx >= 0) await revertOneChange(idx);
    });
    section.appendChild(row);
  }
  treeEl.appendChild(section);
}

function keepAllChanges() {
  clearChangesBar();
  // Сохраняем чат, иначе при перезаходе бар появится снова (agentChanges всё ещё лежат на диске).
  persistChat().catch(() => {});
  setStatus('Изменения приняты');
}

async function undoAllChanges() {
  if (!confirm(`Откатить ${state.agentChanges.length} изменений?`)) return;
  for (const c of state.agentChanges.slice().reverse()) {
    try {
      if (c.lastType === 'create') {
        await window.app.rm(c.path);
      } else if (c.lastType === 'write' && c.oldContent !== null && c.oldContent !== undefined) {
        await window.app.writeAuto(c.path, c.oldContent);
      } else if (c.lastType === 'delete' && c.oldContent !== null && c.oldContent !== undefined) {
        await window.app.writeAuto(c.path, c.oldContent);
      }
    } catch (e) {}
  }
  clearChangesBar();
  await persistChat().catch(() => {});
  setStatus('Изменения откачены');
}

function setStatus(text) {
  const el = $('chat-status') || $('toast');
  if (!el) return;
  el.textContent = text || '';
}

// ----- мелкие стабы для функций которых ещё нет -----
function closeSettings() { const el = $('settings-modal'); if (el) el.classList.remove('open'); }
async function saveSettings() {
  state.settings.autoConfirm = !!$('setting-auto-confirm')?.checked;
  state.settings.showHidden = !!$('setting-show-hidden')?.checked;
  const prevDisableProxy = !!state.settings.disableProxy;
  const prevCustomProxy = state.settings.customProxy || '';
  state.settings.disableProxy = !!$('setting-disable-proxy')?.checked;
  state.settings.customProxy = ($('setting-custom-proxy')?.value || '').trim();
  const proxyChanged = (prevDisableProxy !== state.settings.disableProxy)
    || (prevCustomProxy !== state.settings.customProxy);
  try { await window.app.setSettings(state.settings); } catch (_) {}
  closeSettings();
  setStatus('Сохранено');
  if (proxyChanged) {
    if (confirm('Настройки прокси изменены. Перезапустить приложение сейчас чтобы они применились?')) {
      try { await window.app.relaunch(); } catch (_) {}
    } else {
      setStatus('Сохранено. Прокси-настройки применятся после перезапуска.');
    }
  }
}
// Терминал: список инстансов и активный.
const termState = { instances: [], activeId: null, fitAddon: null, dataSub: null, exitSub: null };

function toggleTerminal() {
  const p = $('terminal-panel');
  if (!p) return;
  const willOpen = !p.classList.contains('open');
  p.classList.toggle('open', willOpen);
  if (willOpen) {
    if (termState.instances.length === 0) {
      createTerminalInstance('powershell').catch(err => setStatus('Терминал: ' + err.message));
    } else {
      // refit
      try { termState.fitAddon?.fit(); } catch (_) {}
    }
  }
}

function resolveTerminalCwd(cwdOverride) {
  if (cwdOverride) return cwdOverride;
  if (state.rootDir) return state.rootDir;
  const recent = state.settings?.recentDirs;
  if (Array.isArray(recent) && recent.length > 0) return recent[0];
  return null;
}

async function createTerminalInstance(shellName, cwdOverride) {
  const host = $('terminal-host');
  if (!host) return;
  if (typeof Terminal !== 'function') {
    host.textContent = 'xterm.js не загружен.';
    return;
  }
  const cwd = resolveTerminalCwd(cwdOverride);
  // Сначала спрашиваем у main о создании процесса.
  let id;
  try {
    id = await window.app.term.create(cwd, shellName);
  } catch (e) {
    setStatus('Терминал: ' + (e?.message || e));
    return;
  }
  if (!id || (typeof id === 'object' && id.error)) {
    setStatus('Терминал: ' + (id?.error || 'не удалось запустить ' + shellName));
    return;
  }
  // Создаём xterm уже только когда ID точно есть.
  const TerminalCls = window.Terminal || window.xterm?.Terminal;
  if (typeof TerminalCls !== 'function') {
    setStatus('Терминал: класс Terminal не найден (xterm не загружен)');
    return;
  }
  const term = new TerminalCls({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Consolas, "JetBrains Mono", monospace',
    theme: {
      background: '#1e1e1e',
      foreground: '#ffffff',
      cursor: '#ffffff',
      cursorAccent: '#1e1e1e',
      selectionBackground: 'rgba(255,255,255,0.22)'
    },
    allowProposedApi: true,
    convertEol: true,
    scrollback: 5000
  });
  // FitAddon UMD экспортирует объект {FitAddon: class}, а не сам класс.
  let FitAddonCls = null;
  if (typeof window.FitAddon === 'function') FitAddonCls = window.FitAddon;
  else if (window.FitAddon?.FitAddon) FitAddonCls = window.FitAddon.FitAddon;
  const fit = FitAddonCls ? new FitAddonCls() : null;
  if (fit) term.loadAddon(fit);

  // Перед term.open контейнер ОБЯЗАТЕЛЬНО должен быть видимым, иначе xterm не посчитает размер.
  // Скроем СТАРЫЕ инстансы вместо нового.
  for (const inst of termState.instances) inst.wrap.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = 'term-instance';
  wrap.dataset.id = id;
  wrap.style.display = 'block';
  host.appendChild(wrap);
  term.open(wrap);

  // Перехватываем Ctrl+L / Ctrl+K на уровне xterm, чтобы он сам не эмитил их в onData —
  // эти комбинации зарезервированы под «добавить контекст» / «inline-правка».
  term.attachCustomKeyEventHandler?.((e) => {
    if (e.type !== 'keydown') return true;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L' || e.key === 'k' || e.key === 'K')) {
      // Возвращаем false → xterm не обработает клавишу. Document-level listener (capture)
      // у нас всё равно перехватит её и вызовет ctrlLAddSelection / openCtrlKPrompt.
      return false;
    }
    return true;
  });

  // ПКМ в терминале — как в Windows-консоли: есть выделение → копировать его в буфер,
  // нет выделения → вставить из буфера в командную строку.
  wrap.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    try {
      const sel = term.hasSelection?.() ? term.getSelection() : '';
      if (sel) {
        await navigator.clipboard.writeText(sel);
        term.clearSelection?.();
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!text) return;
      // Симулируем ввод текста как будто пользователь его набрал.
      // Берёт оба пути: hasPty=true → отправка через IPC в shell; hasPty=false → локальный лайн-эдит.
      term.paste ? term.paste(text) : null;
      // Fallback: вручную дёрнуть onData-обработчик через write_to_input.
      // xterm.js term.paste обычно достаточен — он эмитит onData с pasted-данными.
    } catch (_) {}
  });

  // Состояние локального line-editing (используется в fallback-режиме без pty).
  // Объявляем заранее, чтобы off1 мог обновлять promptCol/promptRow в коллбэке после term.write.
  const lineState = { buf: '', history: [], hIdx: -1, awaitingCmd: false, promptCol: 0, promptRow: 0 };
  const promptRe = />\s\x1b\[0m\s?$|>\s$/;
  const off1 = window.app.term.onData(({ id: tid, data }) => {
    if (tid !== id) return;
    term.write(data, () => {
      // Когда поступил prompt (PS path>) — фиксируем позицию курсора и снимаем awaitingCmd.
      // Это барьер: backspace не сможет стирать левее этой колонки.
      if (promptRe.test(data)) {
        lineState.awaitingCmd = false;
        lineState.pos = 0;
        const b = term.buffer.active;
        lineState.promptCol = b.cursorX;
        lineState.promptRow = b.cursorY + b.baseY;
      }
    });
  });
  const off2 = window.app.term.onExit(({ id: tid, code }) => {
    if (tid === id) term.writeln(`\r\n\x1b[33m[процесс завершён, код ${code}]\x1b[0m`);
  });
  // Если в main.js нет node-pty — делаем локальное line-editing + shell-эмулятор (каждая команда — spawn).
  const hasPty = await window.app.term.hasPty().catch(() => false);
  if (hasPty) {
    term.onData((data) => { window.app.term.write(id, data); });
  } else {
    // Оранжевый цвет ввода (как PSReadLine в pwsh / VS Code).
    const INPUT_ON = '\x1b[38;2;209;154;102m';
    const INPUT_OFF = '\x1b[0m';
    const writeInput = (s) => term.write(INPUT_ON + s + INPUT_OFF);
    // Позиция курсора внутри строки ввода (0..buf.length).
    lineState.pos = 0;

    // Перерисовать хвост строки от курсора до конца, вернуть курсор на pos.
    const redrawTail = () => {
      const tail = lineState.buf.slice(lineState.pos);
      term.write('\x1b[K'); // erase till EOL
      if (tail) {
        writeInput(tail);
        term.write('\x1b[' + tail.length + 'D');
      }
    };
    const replaceLine = (newBuf) => {
      // Перемещаем курсор в конец видимого ввода (на случай если он в середине).
      const moveRight = lineState.buf.length - lineState.pos;
      if (moveRight > 0) term.write('\x1b[' + moveRight + 'C');
      // Стираем всё (количество шагов = длина старого buf).
      for (let i = 0; i < lineState.buf.length; i++) term.write('\b \b');
      lineState.buf = newBuf;
      lineState.pos = newBuf.length;
      writeInput(newBuf);
    };

    term.onData((data) => {
      // 0) пока команда выполняется — всё в stdin процесса.
      if (lineState.awaitingCmd) {
        for (const ch of data) {
          const code = ch.charCodeAt(0);
          if (code === 3) window.app.term.interrupt(id).catch(() => {});
          else window.app.term.write(id, ch).catch(() => {});
        }
        return;
      }

      // 1) Спецпоследовательности (стрелки, Home, End, Delete) — обрабатываем целиком.
      if (data === '\x1b[A') { // ↑ history prev
        if (lineState.history.length === 0) return;
        if (lineState.hIdx > 0) lineState.hIdx--;
        replaceLine(lineState.history[lineState.hIdx] || '');
        return;
      }
      if (data === '\x1b[B') { // ↓ history next
        if (lineState.hIdx < lineState.history.length - 1) {
          lineState.hIdx++;
          replaceLine(lineState.history[lineState.hIdx] || '');
        } else {
          lineState.hIdx = lineState.history.length;
          replaceLine('');
        }
        return;
      }
      if (data === '\x1b[D') { // ←
        if (lineState.pos > 0) { lineState.pos--; term.write('\x1b[D'); }
        return;
      }
      if (data === '\x1b[C') { // →
        if (lineState.pos < lineState.buf.length) { lineState.pos++; term.write('\x1b[C'); }
        return;
      }
      if (data === '\x1b[H' || data === '\x01') { // Home / Ctrl-A
        if (lineState.pos > 0) { term.write('\x1b[' + lineState.pos + 'D'); lineState.pos = 0; }
        return;
      }
      if (data === '\x1b[F' || data === '\x05') { // End / Ctrl-E
        const dx = lineState.buf.length - lineState.pos;
        if (dx > 0) { term.write('\x1b[' + dx + 'C'); lineState.pos = lineState.buf.length; }
        return;
      }
      if (data === '\x1b[3~') { // Delete (вперёд)
        if (lineState.pos < lineState.buf.length) {
          lineState.buf = lineState.buf.slice(0, lineState.pos) + lineState.buf.slice(lineState.pos + 1);
          redrawTail();
        }
        return;
      }
      // Любая другая ESC-последовательность — съесть, не печатать.
      if (data.startsWith('\x1b')) return;

      // 2) Обычный ввод и однобайтные управляющие — посимвольно.
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          const cmd = lineState.buf;
          if (cmd.trim()) { lineState.history.push(cmd); lineState.hIdx = lineState.history.length; }
          lineState.buf = ''; lineState.pos = 0;
          lineState.awaitingCmd = true;
          window.app.term.execLine(id, cmd).catch(() => {});
        } else if (code === 127 || code === 8) {
          // Backspace в середине строки — удаляем символ слева от курсора.
          if (lineState.pos > 0) {
            lineState.buf = lineState.buf.slice(0, lineState.pos - 1) + lineState.buf.slice(lineState.pos);
            lineState.pos--;
            term.write('\b');
            redrawTail();
          }
        } else if (code === 3) {
          term.write('^C\r\n');
          lineState.buf = ''; lineState.pos = 0;
          window.app.term.execLine(id, '').catch(() => {});
        } else if (code === 12) {
          // Ctrl+L занят под «добавить контекст в чат» — терминал не чистим.
          // Очистка доступна командой `cls`.
        } else if (code >= 32 || ch === '\t') {
          // Вставка символа на позицию курсора.
          lineState.buf = lineState.buf.slice(0, lineState.pos) + ch + lineState.buf.slice(lineState.pos);
          lineState.pos++;
          if (lineState.pos === lineState.buf.length) {
            writeInput(ch);
          } else {
            writeInput(ch);
            redrawTail();
          }
        }
      }
    });
  }
  term.onResize(({ cols, rows }) => { window.app.term.resize?.(id, cols, rows).catch(() => {}); });

  termState.instances.push({
    id, shell: shellName, term, fit, wrap,
    dispose: () => { off1(); off2(); term.dispose(); wrap.remove(); }
  });
  setActiveTerminal(id);
  renderTermInstances();
  setTimeout(() => { try { fit?.fit(); term.focus(); } catch (_) {} }, 50);
}

const SHELL_LABEL = {
  powershell: 'pwsh',
  pwsh: 'pwsh',
  cmd: 'cmd',
  gitbash: 'bash',
  wsl: 'wsl'
};
const SHELL_ICON_COLOR = {
  powershell: '#3a9ad9',
  pwsh: '#3a9ad9',
  cmd: '#cccccc',
  gitbash: '#f5a623',
  wsl: '#e95420'
};

function setActiveTerminal(id) {
  termState.activeId = id;
  for (const inst of termState.instances) {
    inst.wrap.style.display = inst.id === id ? 'block' : 'none';
  }
  const active = termState.instances.find(x => x.id === id);
  termState.fitAddon = active?.fit || null;
  if (active) {
    setTimeout(() => { try { active.fit?.fit(); active.term.focus(); } catch (_) {} }, 30);
  }
  // Подпись активного терминала в шапке (как pwsh у VS Code).
  const label = $('term-active-label');
  if (label) {
    if (active) {
      const shellName = SHELL_LABEL[active.shell] || active.shell || '';
      label.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
          '<path d="M3 4l3 3-3 3M8 11h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
        '<span>' + shellName + '</span>';
    } else {
      label.innerHTML = '';
    }
  }
  // Скрываем sidebar если терминалов <=1.
  const sidebar = $('term-instances');
  if (sidebar) sidebar.style.display = termState.instances.length > 1 ? '' : 'none';
  renderTermInstances();
}

function renderTermInstances() {
  const host = $('term-instances');
  if (!host) return;
  host.innerHTML = '';
  termState.instances.forEach((inst, idx) => {
    const item = document.createElement('button');
    item.className = 'term-side-item' + (inst.id === termState.activeId ? ' active' : '');
    item.title = (idx + 1) + ': ' + (SHELL_LABEL[inst.shell] || inst.shell);
    const color = SHELL_ICON_COLOR[inst.shell] || '#cccccc';
    item.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" style="color:' + color + '">' +
        '<rect x="1" y="2" width="14" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
        '<path d="M4 6l2 2-2 2M8 10h4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    item.addEventListener('click', (e) => { e.stopPropagation(); setActiveTerminal(inst.id); });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm('Закрыть терминал ' + (SHELL_LABEL[inst.shell] || inst.shell) + '?')) {
        window.app.term.kill(inst.id).catch(() => {});
        inst.dispose();
        termState.instances = termState.instances.filter(x => x.id !== inst.id);
        if (termState.instances.length > 0) setActiveTerminal(termState.instances[0].id);
        else { termState.activeId = null; renderTermInstances(); $('terminal-panel')?.classList.remove('open'); }
      }
    });
    host.appendChild(item);
  });
}

function getActiveTermInst() {
  return termState.instances.find(x => x.id === termState.activeId) || null;
}

function clearActiveTerminal() {
  const inst = getActiveTermInst();
  if (!inst) return;
  try { inst.term.clear(); } catch (_) {}
  // Если не PTY — попросим эмулятор перерисовать prompt.
  window.app.term.hasPty().then((hasPty) => {
    if (!hasPty) window.app.term.execLine(inst.id, 'cls').catch(() => {});
  }).catch(() => {});
}

// Скан буфера xterm на строки-prompt (PS *>) и переход к ним вверх/вниз.
function scrollTerminalToCommand(direction) {
  const inst = getActiveTermInst();
  if (!inst?.term?.buffer?.active) return;
  const buf = inst.term.buffer.active;
  const total = buf.length;
  const promptRe = /^(PS\s.+>\s)|(\$\s)|(>\s*$)/;
  const prompts = [];
  for (let i = 0; i < total; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const s = line.translateToString(true);
    if (promptRe.test(s)) prompts.push(i);
  }
  if (!prompts.length) return;
  const cur = buf.viewportY;
  let target;
  if (direction === 'next') {
    target = prompts.find(y => y > cur);
    if (target == null) target = prompts[prompts.length - 1];
  } else {
    for (let i = prompts.length - 1; i >= 0; i--) { if (prompts[i] < cur) { target = prompts[i]; break; } }
    if (target == null) target = prompts[0];
  }
  try { inst.term.scrollToLine(target); } catch (_) {}
}

async function runActiveFileInTerminal() {
  if (!state.activeFile) { setStatus('Нет открытого файла'); return; }
  let id = termState.activeId;
  if (!id) {
    try { await createTerminalInstance('powershell'); id = termState.activeId; } catch (_) { return; }
  }
  if (!id) return;
  $('terminal-panel')?.classList.add('open');
  const file = state.activeFile;
  const ext = (file.split('.').pop() || '').toLowerCase();
  const q = (p) => /\s/.test(p) ? `"${p}"` : p;
  let cmd;
  switch (ext) {
    case 'py':  cmd = `python ${q(file)}`; break;
    case 'js':  cmd = `node ${q(file)}`; break;
    case 'ts':  cmd = `npx ts-node ${q(file)}`; break;
    case 'ps1': cmd = `& ${q(file)}`; break;
    case 'bat': case 'cmd': cmd = q(file); break;
    case 'sh':  cmd = `bash ${q(file)}`; break;
    default:    cmd = `& ${q(file)}`; break;
  }
  try { await window.app.term.execLine(id, cmd); } catch (_) {}
}

async function runSelectedTextInTerminal() {
  if (!state.editor) { setStatus('Нет редактора'); return; }
  let sel = '';
  try {
    const r = state.editor.getSelection?.();
    const model = state.editor.getModel?.();
    if (r && model && !(r.startLineNumber === r.endLineNumber && r.startColumn === r.endColumn)) {
      sel = model.getValueInRange(r) || '';
    }
  } catch (_) {}
  if (!sel.trim()) { setStatus('Сначала выделите текст'); return; }
  let id = termState.activeId;
  if (!id) {
    try { await createTerminalInstance('powershell'); id = termState.activeId; } catch (_) { return; }
  }
  if (!id) return;
  $('terminal-panel')?.classList.add('open');
  // Каждую непустую строку — отдельная команда (как VS Code).
  const lines = sel.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    try { await window.app.term.execLine(id, line); } catch (_) {}
  }
}

function handleTermMoreAction(act) {
  switch (act) {
    case 'clear':        clearActiveTerminal(); break;
    case 'scroll-next':  scrollTerminalToCommand('next'); break;
    case 'scroll-prev':  scrollTerminalToCommand('prev'); break;
    case 'run-file':     runActiveFileInTerminal(); break;
    case 'run-selection':runSelectedTextInTerminal(); break;
  }
}

async function killActiveTerminal() {
  const id = termState.activeId;
  if (!id) return;
  try { await window.app.term.kill(id); } catch (_) {}
  const inst = termState.instances.find(x => x.id === id);
  if (inst) { inst.dispose(); termState.instances = termState.instances.filter(x => x.id !== id); }
  if (termState.instances.length > 0) setActiveTerminal(termState.instances[0].id);
  else { termState.activeId = null; renderTermInstances(); $('terminal-panel')?.classList.remove('open'); }
}

function initTerminalUI() {
  $('term-close')?.addEventListener('click', () => $('terminal-panel')?.classList.remove('open'));
  $('term-kill')?.addEventListener('click', killActiveTerminal);
  $('term-new')?.addEventListener('click', () => createTerminalInstance('powershell').catch(() => {}));
  $('term-new-dropdown')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('term-profile-menu');
    const btn = $('term-new-dropdown');
    if (!menu || !btn) return;
    const r = btn.getBoundingClientRect();
    menu.style.right = (window.innerWidth - r.right) + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    menu.classList.toggle('open');
  });
  document.addEventListener('click', () => {
    $('term-profile-menu')?.classList.remove('open');
    $('term-more-menu')?.classList.remove('open');
  });
  document.querySelectorAll('.term-profile-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      $('term-profile-menu')?.classList.remove('open');
      createTerminalInstance(item.dataset.shell).catch(err => setStatus('Терминал: ' + err.message));
    });
  });
  // «⋯» меню в шапке терминала
  document.querySelector('.term-more')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('term-more-menu');
    const btn = e.currentTarget;
    if (!menu || !btn) return;
    const r = btn.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    $('term-profile-menu')?.classList.remove('open');
    menu.classList.toggle('open');
  });
  document.querySelectorAll('.term-more-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      $('term-more-menu')?.classList.remove('open');
      handleTermMoreAction(item.dataset.act);
    });
  });
  // ResizeObserver — фит при изменении размера панели.
  const panel = $('terminal-panel');
  if (panel && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      try { termState.fitAddon?.fit(); } catch (_) {}
    }).observe(panel);
  }
  // Табы Problems / Output / Terminal — заглушки кроме Terminal.
  document.querySelectorAll('.term-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.term-tab').forEach(x => x.classList.toggle('active', x === t));
      if (t.dataset.tab !== 'terminal') setStatus('Эта вкладка пока не реализована');
    });
  });
}
// ===== Встроенный браузер на <webview> (Google/GitHub login и т.п.) =====
function initInAppBrowser() {
  const modal = $('browser-modal');
  const wv = $('inapp-webview');
  const urlInput = $('browser-url');
  if (!modal || !wv || !urlInput) return;

  const normalize = (u) => {
    let s = String(u || '').trim();
    if (!s) return 'about:blank';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s === 'about:blank') return s;
    if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(s)) return 'https://' + s;
    return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  };
  const navigate = (u) => { try { wv.src = normalize(u); } catch (_) {} };
  const close = () => { modal.classList.remove('open'); };

  $('btn-browser-top')?.addEventListener('click', () => openInAppBrowser('https://www.google.com'));
  $('browser-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) { close(); e.stopPropagation(); }
  });
  $('browser-back')?.addEventListener('click', () => { try { wv.goBack(); } catch (_) {} });
  $('browser-fwd')?.addEventListener('click', () => { try { wv.goForward(); } catch (_) {} });
  $('browser-reload')?.addEventListener('click', () => { try { wv.reload(); } catch (_) {} });
  $('browser-go')?.addEventListener('click', () => navigate(urlInput.value));
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(urlInput.value); });
  $('browser-quick-google')?.addEventListener('click', () => navigate('https://accounts.google.com'));
  $('browser-quick-github')?.addEventListener('click', () => navigate('https://github.com/login'));

  wv.addEventListener('did-navigate', (e) => { urlInput.value = e.url; updateBrowserNavState(); });
  wv.addEventListener('did-navigate-in-page', (e) => { urlInput.value = e.url; updateBrowserNavState(); });
  wv.addEventListener('did-stop-loading', updateBrowserNavState);
  // Открытие новых вкладок (target=_blank) внутри того же webview.
  wv.addEventListener('new-window', (e) => { try { navigate(e.url); } catch (_) {} });
}

function updateBrowserNavState() {
  const wv = $('inapp-webview');
  if (!wv) return;
  try {
    $('browser-back').disabled = !wv.canGoBack();
    $('browser-fwd').disabled = !wv.canGoForward();
  } catch (_) {}
}

function openInAppBrowser(url) {
  const modal = $('browser-modal');
  const wv = $('inapp-webview');
  const urlInput = $('browser-url');
  if (!modal || !wv) return;
  modal.classList.add('open');
  try { wv.src = url || 'about:blank'; } catch (_) {}
  if (urlInput) urlInput.value = url || '';
}

// Простой авто-флоу: ждём логина (meta user-login), сохраняем username, закрываем.
// Без создания токена — git push в этом случае попросит логин в терминале, но в UI
// мы помечаем GitHub как «подключён», как просил пользователь.
let _githubCaptureOn = false;
function startGithubAutoCapture() {
  if (_githubCaptureOn) return;
  _githubCaptureOn = true;
  const wv = $('inapp-webview');
  if (!wv) return;

  const setOverlay = (text) => {
    const modal = $('browser-modal');
    if (!modal) return;
    let ov = modal.querySelector('.gh-overlay');
    if (!text) { ov?.remove(); return; }
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'gh-overlay';
      ov.innerHTML = '<div class="gh-overlay-card"><div class="gh-spinner"></div><div class="gh-overlay-text"></div></div>';
      modal.querySelector('.browser-window')?.appendChild(ov);
    }
    ov.querySelector('.gh-overlay-text').textContent = text;
  };

  const tryCapture = async () => {
    if (!_githubCaptureOn) return;
    let username = '';
    try {
      username = await wv.executeJavaScript(
        '(document.querySelector("meta[name=user-login]")?.content || "")'
      );
    } catch (_) {}
    if (!username) return;

    _githubCaptureOn = false;
    setOverlay('Подключено: ' + username);
    // Сохраняем только username — без токена. Git push потом попросит креды в терминале,
    // но в UI отметим аккаунт как подключённый (что и просил пользователь).
    await window.app.git.setAuth({ username, token: '' });
    await renderGitPanel();
    setTimeout(() => {
      $('browser-modal')?.classList.remove('open');
      setOverlay('');
    }, 800);
  };

  const onLoad = () => tryCapture();
  wv.addEventListener('did-stop-loading', onLoad);
  wv.addEventListener('did-navigate', onLoad);

  const stop = () => {
    _githubCaptureOn = false;
    wv.removeEventListener('did-stop-loading', onLoad);
    wv.removeEventListener('did-navigate', onLoad);
    setOverlay('');
  };
  $('browser-close')?.addEventListener('click', stop, { once: true });
}

function initActivityBar() {
  document.querySelectorAll('#activity-bar .ab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('#activity-bar .ab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
      if (view === 'git') renderGitPanel();
    });
  });
  $('git-refresh')?.addEventListener('click', () => renderGitPanel());
  // Welcome links
  $('w-open')?.addEventListener('click', async () => {
    const dir = await window.app.openDir();
    if (dir) await openDir(dir);
  });
  $('w-clone')?.addEventListener('click', () => { const m = $('clone-modal'); if (m) m.classList.add('open'); });
  $('w-new')?.addEventListener('click', () => setStatus('Создание файла в этой сборке отключено'));
  $('w-settings')?.addEventListener('click', openSettings);
  // Topbar buttons
  $('btn-terminal')?.addEventListener('click', toggleTerminal);
  $('term-close')?.addEventListener('click', () => $('terminal-panel')?.classList.remove('open'));
  $('term-new')?.addEventListener('click', () => setStatus('Создание нового терминала не поддерживается в этой сборке'));
  // Inline AI правка (Ctrl+K в редакторе).
  $('inline-cancel')?.addEventListener('click', closeInlineEditPrompt);
  $('inline-submit')?.addEventListener('click', inlineEditAction);
  $('inline-text')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); inlineEditAction(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeInlineEditPrompt(); }
  });
  // Терминальный командный промпт (Ctrl+K).
  $('term-cmd-close')?.addEventListener('click', closeTermCmdPrompt);
  $('term-cmd-gen')?.addEventListener('click', generateTermCommand);
  $('term-cmd-insert')?.addEventListener('click', () => insertTermCommand(false));
  $('term-cmd-run')?.addEventListener('click', () => insertTermCommand(true));
  $('term-cmd-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generateTermCommand(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeTermCmdPrompt(); }
  });
  // Settings tabs (if any)
  document.querySelectorAll('.settings-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.settings-panel').forEach(p => p.style.display = p.dataset.panel === t.dataset.tab ? '' : 'none');
    });
  });
  // Global Ctrl+,  Ctrl+`
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === ',') { e.preventDefault(); openSettings(); }
    else if (ctrl && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); toggleTerminal(); }
    else if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
      if ($('inline-prompt')?.classList.contains('open')) closeInlineEditPrompt();
      if ($('term-cmd-prompt')?.classList.contains('open')) closeTermCmdPrompt();
    }
  });
  // Ctrl+K / Ctrl+L — в capture-фазе, чтобы xterm не успел отправить Ctrl+K (VT 0x0B)
  // в shell и чтобы Monaco не перехватил клавиши на «Select Line» / своё «Quick Fix».
  // chat-input при этом может перехватить Ctrl+L через stopPropagation в своём bubble-handler'е.
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    // Если фокус в chat-input — пускай его локальный listener сам решит (он умеет выбирать
    // между «копировать выделение» и «открыть диалог»). Для этого не перехватываем здесь.
    const ae = document.activeElement;
    const inChatInput = ae && ae.id === 'chat-input';
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      e.stopPropagation();
      openCtrlKPrompt();
    } else if ((e.key === 'l' || e.key === 'L') && !inChatInput) {
      e.preventDefault();
      e.stopPropagation();
      ctrlLAddSelection();
    }
  }, true);
}
function initImageHandlers() {
  $('btn-attach')?.addEventListener('click', () => $('file-input')?.click());
  $('file-input')?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) await addImageFile(f);
    e.target.value = '';
  });
  // Вставка картинок из буфера (Ctrl+V со скриншотом, копи-паст из браузера/Скетча и т.п.).
  $('chat-input')?.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items || [];
    let handled = false;
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) { await addImageFile(blob); handled = true; }
      }
    }
    if (handled) e.preventDefault();
  });
}

async function addImageFile(file) {
  // Принимаем только картинки. Преобразуем в base64, кладём в контекст-чипы.
  if (!file.type?.startsWith('image/')) {
    setStatus('Не картинка: ' + (file.name || file.type)); return;
  }
  const MAX = 8 * 1024 * 1024; // 8 МБ — провайдеры обычно режут больше.
  if (file.size > MAX) { setStatus(`Картинка слишком большая (>${(MAX/1024/1024)|0} МБ)`); return; }
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const m = s.match(/^data:[^;]+;base64,(.+)$/);
      resolve(m ? m[1] : '');
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  if (!data) { setStatus('Не удалось прочитать картинку'); return; }
  state.contextFiles = state.contextFiles || [];
  state.contextFiles.push({
    kind: 'image',
    mimeType: file.type,
    data,
    name: file.name || ('image-' + Date.now() + '.' + (file.type.split('/')[1] || 'png'))
  });
  renderContextChips();
  setStatus('Добавлена картинка: ' + file.name);
}
function initPalette() {}

function initTopbarSearch() {
  const input = $('topbar-search-input');
  const results = $('topbar-search-results');
  if (!input || !results) return;
  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => doTopbarSearch(input.value.trim()), 200);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim()) doTopbarSearch(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; results.classList.remove('open'); input.blur(); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.topbar-search')) results.classList.remove('open');
  });
}

async function doTopbarSearch(query) {
  const results = $('topbar-search-results');
  if (!results) return;
  if (!query) { results.classList.remove('open'); return; }
  if (!state.rootDir) {
    results.innerHTML = '<div class="ts-empty">Откройте папку, чтобы искать</div>';
    results.classList.add('open');
    return;
  }
  const all = await window.app.listAll(state.rootDir).catch(() => []);
  const q = query.toLowerCase();
  const matches = (all || [])
    .filter(p => p.toLowerCase().includes(q))
    .slice(0, 30);
  results.innerHTML = '';
  if (matches.length === 0) {
    results.innerHTML = '<div class="ts-empty">Ничего не найдено</div>';
  } else {
    for (const rel of matches) {
      const item = document.createElement('div');
      item.className = 'ts-item';
      const name = rel.split(/[\\/]/).pop();
      const dir = rel.slice(0, rel.length - name.length).replace(/[\\/]$/, '');
      item.innerHTML = '<span class="ts-name"></span><span class="ts-dir"></span>';
      item.querySelector('.ts-name').textContent = name;
      item.querySelector('.ts-dir').textContent = dir;
      item.addEventListener('click', () => {
        const full = state.rootDir + (state.rootDir.endsWith('\\') ? '' : '\\') + rel;
        openFile(full, name);
        results.classList.remove('open');
        $('topbar-search-input').value = '';
      });
      results.appendChild(item);
    }
  }
  results.classList.add('open');
}
async function initMonaco() {
  // Pre-warm Monaco в фоне — не блокируя init.
  ensureMonaco().catch(() => {});
}
function openPalette() {}
function saveCurrent() { saveActiveFile(); }
async function openDir(dir) {
  state.rootDir = dir;
  state.agentCwd = dir;
  await pushRecentDir(dir);
  await refreshTreeQuiet();
  const w = $('welcome'); if (w) w.style.display = 'none';
  setStatus(dir);
  // Если Git-вкладка открыта — обновим её под новый репозиторий.
  if ($('view-git')?.classList.contains('active')) renderGitPanel();
}

async function openFile(filePath, fileName) {
  // Если файл уже открыт — просто переключаем активный таб.
  if (state.openFiles.has(filePath)) {
    setActiveTab(filePath);
    return;
  }
  const r = await window.app.read(filePath);
  if (r?.error) { setStatus('Не открыть: ' + r.error); return; }
  const lang = langForFile(fileName || filePath);
  const ed = await ensureMonaco();
  if (!ed) {
    setStatus('Monaco не загружен — простой просмотр');
    showSimplePreview(filePath, fileName, r.content || '');
    return;
  }
  const model = state.monaco.editor.createModel(r.content || '', lang);
  state.openFiles.set(filePath, { path: filePath, name: fileName || filePath.split(/[\\/]/).pop(), model, lang, dirty: false });
  // Слежение за dirty — отметим звёздочкой в табе.
  model.onDidChangeContent(() => {
    const entry = state.openFiles.get(filePath);
    if (!entry) return;
    if (!entry.dirty) {
      entry.dirty = true;
      renderTabs();
    }
  });
  renderTabs();
  setActiveTab(filePath);
}

function showSimplePreview(filePath, fileName, content) {
  let preview = document.getElementById('file-preview');
  if (!preview) {
    preview = document.createElement('div');
    preview.id = 'file-preview';
    preview.style.cssText = 'flex:1;overflow:auto;background:var(--bg);display:flex;flex-direction:column';
    const editorArea = $('editor-area');
    if (editorArea) editorArea.appendChild(preview);
  }
  preview.innerHTML = `
    <div style="padding:6px 12px;background:var(--bg2);border-bottom:1px solid var(--border);font-size:12px;color:var(--fg2)">${escapeHtml(fileName || filePath)}</div>
    <pre style="margin:0;padding:12px;font-family:'Consolas',monospace;font-size:12px;color:var(--fg);overflow:auto;flex:1;white-space:pre"></pre>`;
  preview.querySelector('pre').textContent = content;
  preview.style.display = '';
  const w = $('welcome'); if (w) w.style.display = 'none';
}

async function ensureMonaco() {
  if (state.editor) return state.editor;
  if (!window.monaco && !window.__monacoReady) {
    await new Promise((resolve) => {
      if (window.__monacoReady) { resolve(); return; }
      const onReady = () => { window.removeEventListener('monaco-ready', onReady); resolve(); };
      window.addEventListener('monaco-ready', onReady);
      // safety timeout
      setTimeout(resolve, 5000);
    });
  }
  if (!window.monaco) return null;
  state.monaco = window.monaco;
  const host = $('monaco');
  if (!host) return null;
  // Контейнер должен быть в потоке flex чтобы Monaco мог вычислить размеры,
  // но скрыт визуально пока нет открытых файлов.
  host.style.flex = '1';
  host.style.minHeight = '0';
  host.style.display = 'none';
  // НЕ скрываем welcome здесь — только при реальном openFile.
  state.editor = window.monaco.editor.create(host, {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 13,
    fontFamily: 'Consolas, "JetBrains Mono", monospace',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    tabSize: 2,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    contextmenu: true,
    fontLigatures: true
  });
  // Ctrl+S — сохранить активный файл.
  state.editor.addCommand(state.monaco.KeyMod.CtrlCmd | state.monaco.KeyCode.KeyS, () => saveActiveFile());
  return state.editor;
}

function renderTabs() {
  const bar = $('tabs');
  if (!bar) return;
  bar.innerHTML = '';
  for (const [path, entry] of state.openFiles) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (path === state.activeFile ? ' active' : '');
    tab.dataset.path = path;
    const icon = document.createElement('span');
    icon.className = 'tab-ficon ' + fileIconCls(entry.name);
    icon.textContent = getFileBadge(entry.name);
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = entry.name + (entry.dirty ? ' •' : '');
    name.title = path;
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.innerHTML = '×';
    close.title = 'Закрыть';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(path); });
    tab.appendChild(icon);
    tab.appendChild(name);
    tab.appendChild(close);
    tab.addEventListener('click', () => setActiveTab(path));
    bar.appendChild(tab);
  }
}

function setActiveTab(filePath) {
  const entry = state.openFiles.get(filePath);
  if (!entry) return;
  state.activeFile = filePath;
  if (state.editor && entry.model) {
    state.editor.setModel(entry.model);
  }
  // Скрываем welcome и simple-preview если есть.
  const w = $('welcome'); if (w) w.style.display = 'none';
  const sp = $('file-preview'); if (sp) sp.style.display = 'none';
  const host = $('monaco'); if (host) host.style.display = 'block';
  renderTabs();
  setStatus(entry.name);
}

async function closeTab(filePath) {
  const entry = state.openFiles.get(filePath);
  if (!entry) return;
  if (entry.dirty) {
    if (!confirm(`У файла "${entry.name}" есть несохранённые изменения. Закрыть без сохранения?`)) return;
  }
  if (entry.model) entry.model.dispose();
  state.openFiles.delete(filePath);
  if (state.activeFile === filePath) {
    // Переключиться на любой оставшийся.
    const next = state.openFiles.keys().next().value;
    if (next) setActiveTab(next);
    else {
      state.activeFile = null;
      if (state.editor) state.editor.setModel(state.monaco.editor.createModel('', 'plaintext'));
      const host = $('monaco'); if (host) host.style.display = 'none';
      const w = $('welcome'); if (w) w.style.display = '';
    }
  }
  renderTabs();
}

async function saveActiveFile() {
  if (!state.activeFile) return;
  const entry = state.openFiles.get(state.activeFile);
  if (!entry || !entry.model) return;
  const content = entry.model.getValue();
  const r = await window.app.write(state.activeFile, content);
  if (r?.error) { setStatus('Ошибка: ' + r.error); return; }
  entry.dirty = false;
  renderTabs();
  setStatus('Сохранено: ' + entry.name);
}

function fileIconCls(name) {
  const ext = (name || '').toLowerCase().split('.').pop();
  const map = {
    js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    ts: 'ts', tsx: 'ts',
    json: 'json', html: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css',
    md: 'md', java: 'java', py: 'py',
    go: 'go', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    php: 'php', sh: 'sh', bat: 'sh', ps1: 'sh',
    yml: 'yml', yaml: 'yml', xml: 'xml',
    png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', svg: 'img', webp: 'img'
  };
  return 'file-' + (map[ext] || 'default');
}

function renderTree(node, depth = 0) {
  const wrap = document.createElement('div');
  if (!node) return wrap;
  const row = makeTreeRow(node, depth);
  wrap.appendChild(row);
  if (node.type === 'dir' && Array.isArray(node.children)) {
    const kids = document.createElement('div');
    kids.className = 'tree-children';
    kids.style.display = 'none';
    for (const child of node.children) kids.appendChild(renderTree(child, depth + 1));
    wrap.appendChild(kids);
    row.dataset.expanded = '0';
    row.querySelector('.chevron').classList.remove('expanded');
  }
  return wrap;
}

function makeTreeRow(node, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row ' + (node.type === 'dir' ? 'is-dir' : 'is-file');
  row.dataset.path = node.path;
  row.dataset.type = node.type;
  row.dataset.name = node.name;
  const indent = document.createElement('span');
  indent.className = 'indent';
  indent.style.width = (depth * 12) + 'px';
  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  if (node.type === 'dir') chevron.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  else chevron.classList.add('hidden');
  const icon = document.createElement('span');
  if (node.type === 'dir') {
    icon.className = 'dir-icon';
    icon.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 3.5h4l1.5 1.5h7.5v8.5h-13z" fill="#dcb86c" stroke="none"/></svg>';
  } else {
    icon.className = 'ficon ' + fileIconCls(node.name);
    icon.textContent = getFileBadge(node.name);
  }
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = node.name;
  name.title = node.path;
  row.appendChild(indent);
  row.appendChild(chevron);
  row.appendChild(icon);
  row.appendChild(name);

  if (node.type === 'dir') {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTreeFolder(row, node);
    });
  } else {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      openFile(node.path, node.name);
    });
  }
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTreeContextMenu(e.clientX, e.clientY, node);
  });
  return row;
}

async function toggleTreeFolder(row, node) {
  const kids = row.nextElementSibling;
  if (!kids || !kids.classList.contains('tree-children')) {
    // lazy load
    const data = await window.app.expand(node.path, { showHidden: !!state.settings.showHidden });
    if (!data || !data.children) return;
    const k = document.createElement('div');
    k.className = 'tree-children';
    for (const child of data.children) {
      const depth = parseInt(row.querySelector('.indent').style.width) / 12 + 1;
      k.appendChild(renderTree(child, depth));
    }
    row.after(k);
    row.querySelector('.chevron').classList.add('expanded');
    row.dataset.expanded = '1';
    return;
  }
  const expanded = row.dataset.expanded === '1';
  kids.style.display = expanded ? 'none' : '';
  row.querySelector('.chevron').classList.toggle('expanded', !expanded);
  row.dataset.expanded = expanded ? '0' : '1';
}

// ============================================================================
// CHAT — Cursor-стиль: Ask / Agent режимы, стрим, tool-блоки в чате.
// ============================================================================

function openSettings() {
  const el = $('settings-modal');
  if (!el) return;
  renderProviderList();
  const ac = $('setting-auto-confirm'); if (ac) ac.checked = !!state.settings.autoConfirm;
  const sh = $('setting-show-hidden'); if (sh) sh.checked = !!state.settings.showHidden;
  const dp = $('setting-disable-proxy'); if (dp) dp.checked = !!state.settings.disableProxy;
  const cp = $('setting-custom-proxy'); if (cp) cp.value = state.settings.customProxy || '';
  refreshGithubStatus();
  el.classList.add('open');
}

async function refreshGithubStatus() {
  const status = await window.app.git.checkAuth().catch(() => ({ connected: false }));
  const txt = $('github-status-text'); const sub = $('github-status-sub'); const logout = $('github-logout'); const form = $('github-login-form');
  if (!txt) return;
  if (status.connected) {
    txt.innerHTML = '✓ Подключено как <b>' + escapeHtml(status.username || '?') + '</b>';
    txt.style.color = '#4ec9b0';
    if (sub) sub.textContent = 'git push / pull / commit будут работать без запроса пароля';
    if (logout) logout.style.display = '';
    if (form) form.style.display = 'none';
  } else {
    txt.textContent = 'Не подключено';
    txt.style.color = '';
    if (sub) sub.textContent = 'Подключи аккаунт GitHub чтобы push/pull/commit работали без ручного ввода пароля';
    if (logout) logout.style.display = 'none';
    if (form) form.style.display = '';
  }
}

// ===== Git-таб в сайдбаре: авторизация GitHub, список изменений, AI-коммит =====
async function renderGitPanel() {
  const root = $('git-content');
  if (!root) return;
  const dir = state.rootDir;
  // Авторизация
  const auth = await window.app.git.checkAuth().catch(() => ({ connected: false }));
  // Статус репо (если папка открыта)
  let st = null;
  if (dir) {
    try { st = await window.app.git.status(dir); } catch (_) { st = { error: String(_) }; }
  }

  const authHtml = auth.connected
    ? `<div class="git-auth-line">✓ <b>${escapeHtml(auth.username || '?')}</b>
         <button class="git-auth-logout">Выйти</button></div>`
    : `<div class="git-auth-box">
         <div class="git-auth-hint">Подключи GitHub чтобы push работал без пароля</div>
         <button class="git-auth-browser-btn">🌐 Авторизация через браузер</button>
         <div class="git-auth-divider"><span>или вручную</span></div>
         <input class="git-auth-username" placeholder="GitHub username" autocomplete="off">
         <input class="git-auth-token" type="password" placeholder="ghp_... или github_pat_..." autocomplete="off">
         <div class="git-auth-row">
           <button class="git-auth-login">Подключить</button>
           <button class="git-auth-create-token">Создать токен →</button>
         </div>
         <div class="git-auth-msg"></div>
       </div>`;

  let repoHtml;
  if (!dir) {
    repoHtml = `<div class="git-empty">Откройте папку с git-репозиторием</div>`;
  } else if (st?.error || st?.repo === false) {
    repoHtml = `<div class="git-empty">
        Это не git-репозиторий.
        <button class="git-init-btn">git init</button>
      </div>`;
  } else {
    const files = st.files || [];
    const filesHtml = files.length
      ? files.map((f, i) => {
          const flag = (f.index + f.working).replace(/ /g, '·');
          return `<label class="git-file">
            <input type="checkbox" class="git-file-cb" data-path="${escapeHtml(f.path)}" checked>
            <span class="git-file-flag" title="index='${escapeHtml(f.index)}' working='${escapeHtml(f.working)}'">${escapeHtml(flag)}</span>
            <span class="git-file-path">${escapeHtml(f.path)}</span>
          </label>`;
        }).join('')
      : `<div class="git-empty" style="padding:8px 4px">Нет изменений</div>`;

    repoHtml = `
      <div class="git-branch-line">
        <span>Ветка: <b>${escapeHtml(st.branch || '?')}</b></span>
        <span class="git-ahead-behind">↑${st.ahead || 0} ↓${st.behind || 0}</span>
      </div>
      <div class="git-files-list">
        <div class="git-files-head">
          <label class="git-files-all"><input type="checkbox" id="git-select-all" checked> Все (${files.length})</label>
        </div>
        ${filesHtml}
      </div>
      <textarea class="git-commit-msg" placeholder="Commit message... (или нажми «🤖 ИИ-коммит» — модель сама напишет)"></textarea>
      <div class="git-actions">
        <button class="git-commit-btn" title="git add + git commit">Commit</button>
        <button class="git-push-btn" title="git push">Push</button>
      </div>
      <div class="git-msg"></div>
    `;
  }

  root.innerHTML = `
    <div class="git-section git-auth-section">${authHtml}</div>
    <div class="git-section git-repo-section">${repoHtml}</div>`;

  wireGitPanel(root, dir, st);
}

function wireGitPanel(root, dir, st) {
  // --- авторизация ---
  root.querySelector('.git-auth-login')?.addEventListener('click', async () => {
    const username = root.querySelector('.git-auth-username').value.trim();
    const token = root.querySelector('.git-auth-token').value.trim();
    const msg = root.querySelector('.git-auth-msg');
    if (!username || !token) { msg.textContent = 'Введи username и токен'; msg.style.color = '#f48771'; return; }
    if (!/^(ghp_|github_pat_)/.test(token)) {
      msg.textContent = 'Токен должен начинаться с ghp_ или github_pat_';
      msg.style.color = '#dcdcaa';
      return;
    }
    msg.textContent = 'Сохраняю...'; msg.style.color = '';
    const r = await window.app.git.setAuth({ username, token });
    if (r?.error) { msg.textContent = '✗ ' + r.error; msg.style.color = '#f48771'; return; }
    await renderGitPanel();
  });
  root.querySelector('.git-auth-create-token')?.addEventListener('click', () => {
    openInAppBrowser('https://github.com/settings/tokens/new?scopes=repo,workflow&description=doomsheek%20code');
  });
  root.querySelector('.git-auth-browser-btn')?.addEventListener('click', () => {
    // Открываем чистую страницу логина GitHub. Если юзер уже залогинен — GitHub сразу
    // редиректит на домашнюю; ловим логин по meta-тегу и в фоне создаём токен.
    openInAppBrowser('https://github.com/login');
    startGithubAutoCapture();
  });
  root.querySelector('.git-auth-logout')?.addEventListener('click', async () => {
    await window.app.git.logout();
    await renderGitPanel();
  });

  // --- git init ---
  root.querySelector('.git-init-btn')?.addEventListener('click', async () => {
    if (!dir) return;
    await window.app.git.init(dir);
    await renderGitPanel();
  });

  // --- чекбокс «все/ни одного» ---
  const selAll = root.querySelector('#git-select-all');
  if (selAll) {
    selAll.addEventListener('change', () => {
      root.querySelectorAll('.git-file-cb').forEach(cb => { cb.checked = selAll.checked; });
    });
  }

  const selectedFiles = () => Array.from(root.querySelectorAll('.git-file-cb:checked')).map(cb => cb.dataset.path);

  // --- commit ---
  root.querySelector('.git-commit-btn')?.addEventListener('click', async () => {
    if (!dir) return;
    const files = selectedFiles();
    const msgInput = root.querySelector('.git-commit-msg');
    const message = (msgInput.value || '').trim();
    const status = root.querySelector('.git-msg');
    const showErr = (txt) => {
      console.error('[git commit]', txt);
      status.textContent = '✗ ' + txt;
      status.style.color = '#f48771';
      status.title = txt;
    };
    if (files.length === 0) return showErr('Выбери хотя бы один файл');
    if (!message) return showErr('Введи commit message');
    console.log('[git commit] dir=', dir, 'files=', files, 'msg=', message);
    status.textContent = 'Стейджу...'; status.style.color = ''; status.title = '';
    const stage = await window.app.git.stage(dir, files);
    console.log('[git stage] result:', stage);
    if (stage?.error) return showErr('stage: ' + stage.error);
    status.textContent = 'Коммичу...';
    const c = await window.app.git.commit(dir, message);
    console.log('[git commit] result:', c);
    if (c?.error) return showErr('commit: ' + c.error);
    status.textContent = '✓ Закоммичено: ' + (c.commit || ''); status.style.color = '#4ec9b0';
    msgInput.value = '';
    setTimeout(() => renderGitPanel(), 600);
  });

  // --- push ---
  root.querySelector('.git-push-btn')?.addEventListener('click', async () => {
    if (!dir) return;
    const status = root.querySelector('.git-msg');
    status.textContent = 'Пушу...'; status.style.color = '';
    const r = await window.app.git.push(dir);
    if (r?.error) { status.textContent = '✗ ' + r.error; status.style.color = '#f48771'; return; }
    status.textContent = '✓ Запушено'; status.style.color = '#4ec9b0';
    setTimeout(() => renderGitPanel(), 600);
  });

}

function initGithubTab() {
  $('github-create-token')?.addEventListener('click', () => {
    window.app.openExternal('https://github.com/settings/tokens/new?scopes=repo,workflow&description=doomsheek%20code');
  });
  $('github-save')?.addEventListener('click', async () => {
    const username = $('github-username').value.trim();
    const token = $('github-token').value.trim();
    const msg = $('github-msg');
    if (!username || !token) { msg.textContent = 'Введи и username, и токен'; msg.style.color = '#f48771'; return; }
    if (!/^(ghp_|github_pat_)/.test(token)) {
      msg.textContent = 'Токен должен начинаться с ghp_ или github_pat_';
      msg.style.color = '#dcdcaa';
      return;
    }
    msg.textContent = 'Сохраняю...';
    msg.style.color = '';
    const r = await window.app.git.setAuth({ username, token });
    if (r?.error) { msg.textContent = '✗ ' + r.error; msg.style.color = '#f48771'; return; }
    msg.textContent = '✓ Подключено';
    msg.style.color = '#4ec9b0';
    $('github-token').value = '';
    await refreshGithubStatus();
  });
  $('github-logout')?.addEventListener('click', async () => {
    await window.app.git.logout();
    await refreshGithubStatus();
  });
}

function renderProviderList() {
  const list = $('provider-list');
  if (!list) return;
  list.innerHTML = '';
  for (const [id, p] of Object.entries(state.providers || {})) {
    const key = (state.settings.keys || {})[id] || '';
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.providerId = id;
    const hasKey = key ? '<span class="prov-badge ok">ключ есть</span>' : '<span class="prov-badge none">ключ не задан</span>';
    card.innerHTML = `
      <div class="prov-head">
        <div class="prov-name">${escapeHtml(p.name)}</div>
        ${hasKey}
        <span class="prov-status" data-status></span>
      </div>
      <div class="prov-row">
        <input type="password" class="prov-key" placeholder="${escapeHtml(p.keyHint || 'API key')}" value="${escapeHtml(key)}" autocomplete="off" spellcheck="false">
        <button class="prov-show" data-act="show" title="Показать/скрыть">👁</button>
        <button class="prov-check" data-act="check">Проверить</button>
      </div>
      <div class="prov-models" data-models></div>`;
    list.appendChild(card);
  }
  list.querySelectorAll('.provider-card').forEach((card) => {
    const id = card.dataset.providerId;
    const input = card.querySelector('.prov-key');
    card.querySelector('[data-act="show"]').addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    card.querySelector('[data-act="check"]').addEventListener('click', () => checkProviderKey(id, card));
  });
}

async function checkProviderKey(providerId, card) {
  const input = card.querySelector('.prov-key');
  const statusEl = card.querySelector('.prov-status');
  const modelsEl = card.querySelector('[data-models]');
  const key = (input.value || '').trim();
  if (!key) {
    statusEl.textContent = 'Введите ключ';
    statusEl.className = 'prov-status err';
    return;
  }
  statusEl.textContent = 'Проверяю...';
  statusEl.className = 'prov-status pending';
  try {
    const r = await window.app.checkKey({ providerId, key });
    if (r && r.ok) {
      statusEl.textContent = '✓ валидный';
      statusEl.className = 'prov-status ok';
      state.settings.keys = state.settings.keys || {};
      state.settings.keys[providerId] = key;
      if (Array.isArray(r.models) && r.models.length > 0) {
        state.settings.availableModels = state.settings.availableModels || {};
        state.settings.availableModels[providerId] = r.models;
        modelsEl.innerHTML = `<div class="prov-models-label">Сохранено моделей: ${r.models.length}</div>` +
          r.models.map(m => `<span class="prov-model-chip">${escapeHtml(m)}</span>`).join('');
      } else {
        modelsEl.innerHTML = '<div class="prov-models-label" style="color:var(--fg2)">Ключ валидный (моделей не получено)</div>';
      }
      const badge = card.querySelector('.prov-badge');
      if (badge) { badge.textContent = 'ключ есть'; badge.className = 'prov-badge ok'; }
      await window.app.setSettings(state.settings);
      if (providerId === $('provider-select')?.value) updateModelSelect();
    } else {
      statusEl.textContent = '✗ ' + (r?.error || 'невалидный');
      statusEl.className = 'prov-status err';
    }
  } catch (e) {
    statusEl.textContent = '✗ ' + (e?.message || e);
    statusEl.className = 'prov-status err';
  }
}

const WEB_SEARCH_SUPPORT = new Set(['openai', 'anthropic', 'gemini', 'xai', 'openrouter', 'perplexity']);

function providerSupportsWebSearch(providerId) {
  return WEB_SEARCH_SUPPORT.has(providerId);
}

function updateWebButton() {
  const btn = $('btn-web');
  if (!btn) return;
  const providerId = $('provider-select')?.value;
  const supported = providerSupportsWebSearch(providerId);
  btn.classList.toggle('active', !!state.webSearch && supported);
  btn.classList.toggle('disabled', !supported);
  btn.title = supported
    ? (state.webSearch ? 'Веб-поиск ВКЛ — выкл' : 'Включить веб-поиск')
    : 'Этот провайдер не поддерживает веб-поиск';
}

function initChatUI() {
  // Привязки кнопок чата.
  $('btn-send')?.addEventListener('click', sendChat);
  $('btn-stop')?.addEventListener('click', stopChat);
  $('btn-new-chat')?.addEventListener('click', newChat);
  $('btn-chat-history')?.addEventListener('click', openHistoryModal);
  $('btn-close-chat')?.addEventListener('click', (e) => { e.stopPropagation(); newChat(); });
  $('tab-prev')?.addEventListener('click', () => navigateChat(-1));
  $('tab-next')?.addEventListener('click', () => navigateChat(1));
  $('btn-chat-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const popup = $('chat-menu-popup');
    if (!popup) return;
    const btn = e.currentTarget;
    const r = btn.getBoundingClientRect();
    popup.style.right = (window.innerWidth - r.right) + 'px';
    popup.style.top = (r.bottom + 4) + 'px';
    popup.classList.toggle('open');
  });
  document.addEventListener('click', () => $('chat-menu-popup')?.classList.remove('open'));
  document.querySelectorAll('.chat-menu-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      $('chat-menu-popup')?.classList.remove('open');
      const act = item.dataset.act;
      if (act === 'fork') {
        const old = state.messages.slice();
        newChat();
        state.messages = old.slice();
        for (const m of state.messages) {
          if (m.role === 'system') continue;
          const el = document.createElement('div');
          el.className = 'msg ' + m.role;
          el.innerHTML = '<div class="body"></div>';
          el.querySelector('.body').textContent = typeof m.content === 'string' ? m.content : '';
          $('messages').appendChild(el);
        }
        setStatus('Чат форкнут');
      } else if (act === 'copy-message') {
        const last = [...state.messages].reverse().find(m => m.role === 'assistant');
        if (last) { await navigator.clipboard.writeText(typeof last.content === 'string' ? last.content : '').catch(() => {}); setStatus('Скопировано последнее сообщение'); }
        else setStatus('Нет ответов для копирования');
      } else if (act === 'copy-id') {
        await navigator.clipboard.writeText(state.chatId || '').catch(() => {});
        setStatus('Chat ID скопирован');
      } else if (act === 'settings') openSettings();
    });
  });
  $('mode-ask')?.addEventListener('click', () => setAgentMode(false));
  $('mode-agent')?.addEventListener('click', () => setAgentMode(true));
  $('btn-web')?.addEventListener('click', () => {
    const providerId = $('provider-select')?.value;
    if (!providerSupportsWebSearch(providerId)) {
      setStatus('Этот провайдер не поддерживает веб-поиск. Используй: OpenAI, Anthropic, Gemini, xAI, OpenRouter или Perplexity.');
      return;
    }
    state.webSearch = !state.webSearch;
    updateWebButton();
    setStatus(state.webSearch ? 'Веб-поиск включён' : 'Веб-поиск выключен');
  });
  $('provider-select')?.addEventListener('change', updateWebButton);
  updateWebButton();
  $('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L' || e.code === 'KeyL')) {
      e.preventDefault();
      e.stopPropagation();
      // Если где-то есть выделение (терминал / редактор / DOM) — копируем его.
      // Иначе открываем диалог «введите имя файла».
      const added = ctrlLAddSelection();
      if (!added) openAddContextDialog();
    }
  });
  renderContextChips();
  $('messages')?.addEventListener('scroll', updateScrollBtn);
  $('scroll-down-btn')?.addEventListener('click', () => {
    const m = $('messages'); if (m) { m.scrollTop = m.scrollHeight; updateScrollBtn(); }
  });
}

function initChatHistory() {
  const close = $('history-close');
  if (close) close.addEventListener('click', () => $('history-modal').classList.remove('open'));
  const modal = $('history-modal');
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target.id === 'history-modal') modal.classList.remove('open');
  });
}

function setAgentMode(on) {
  state.agentMode = on;
  applyAgentUI();
}

function isPinnedToBottom() {
  const m = $('messages');
  if (!m) return true;
  return (m.scrollHeight - m.scrollTop - m.clientHeight) < 60;
}
function scrollIfPinned(force) {
  const m = $('messages'); if (!m) return;
  if (force || isPinnedToBottom()) m.scrollTop = m.scrollHeight;
  updateScrollBtn();
}
function updateScrollBtn() {
  const btn = $('scroll-down-btn'); if (!btn) return;
  btn.style.display = isPinnedToBottom() ? 'none' : 'flex';
}

function pushMessage(role, content) {
  const msg = { role, content: content || '' };
  state.messages.push(msg);
  const box = $('messages'); if (!box) return null;
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  const label = role === 'user' ? '' : role === 'assistant' ? '' : 'ошибка';
  const labelHtml = label ? '<div class="role">' + label + '</div>' : '';
  el.innerHTML = labelHtml + '<div class="body"></div>';
  const body = el.querySelector('.body');
  if (role === 'assistant' && content) {
    body.innerHTML = renderMarkdown(content);
    hookupMarkdown(body);
  } else if (Array.isArray(content)) {
    // Multi-part: текст + картинки. Рендерим текст как textContent, картинки как <img>.
    for (const p of content) {
      if (p?.type === 'text' && p.text) {
        const div = document.createElement('div');
        div.textContent = p.text;
        body.appendChild(div);
      } else if (p?.type === 'image' && p.data) {
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = 'data:' + (p.mimeType || 'image/png') + ';base64,' + p.data;
        body.appendChild(img);
      }
    }
  } else {
    body.textContent = content || '';
  }
  // Кнопка копирования для ответов ассистента (видна по hover).
  if (role === 'assistant') addCopyButton(el);
  box.appendChild(el);
  scrollIfPinned(role === 'user');
  return el;
}

// Превращает сырой ответ API ("429 {...}") в человеческое сообщение.
function friendlyApiError(raw, providerId) {
  const text = String(raw || '');
  // Попробуем выдрать message из JSON если он там есть.
  let message = '';
  try {
    const m = text.match(/\{[\s\S]*\}$/);
    if (m) {
      const obj = JSON.parse(m[0]);
      message = obj?.error?.message || obj?.message || obj?.error?.code || '';
    }
  } catch (_) {}

  const lower = text.toLowerCase();

  const isGemini = providerId === 'gemini' || providerId === 'geminiOAuth';
  if (/insufficient_quota|quota.exceeded/i.test(text)) {
    const provName = ({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google AI', geminiOAuth: 'Google AI' })[providerId] || providerId;
    return `Закончились деньги на счёте ${provName}.\n` +
      `Ключ валидный, но баланс исчерпан. Пополни на:\n` +
      (providerId === 'openai' ? 'https://platform.openai.com/settings/organization/billing/overview\n'
       : providerId === 'anthropic' ? 'https://console.anthropic.com/settings/billing\n'
       : isGemini ? 'https://aistudio.google.com/app/apikey (включи billing для проекта)\n'
       : 'странице биллинга провайдера\n') +
      (message ? `\n${message}` : '');
  }
  // Gemini RESOURCE_EXHAUSTED — обычно «исчерпана дневная квота» / «не включён билинг», а не короткий burst.
  if (isGemini && /RESOURCE_EXHAUSTED|check\s*quota/i.test(text)) {
    return `Google AI: исчерпана квота на эту модель.\n` +
      `Free tier у Gemini очень узкий — попробуй: 1) сменить модель на gemini-1.5-flash-latest;\n` +
      `2) подключить billing на https://aistudio.google.com/app/apikey;\n` +
      `3) подождать сутки (квоты обновляются ежедневно).` +
      (message ? `\n\n${message}` : '');
  }
  if (/rate.?limit|429/i.test(text) && !/insufficient/i.test(text)) {
    return `Превышен лимит запросов (rate limit). Подожди немного и попробуй снова.` + (message ? `\n${message}` : '');
  }
  if (/^401\b|invalid.api.key|incorrect.api.key/i.test(text)) {
    return `Невалидный API-ключ для ${providerId}. Открой Настройки → Провайдеры и проверь.` + (message ? `\n${message}` : '');
  }
  if (/missing.scope|insufficient_quota_scope|permission_denied/i.test(text)) {
    return `У ключа нет прав на этот эндпоинт. Если это OpenAI project-key (sk-proj-) — на странице ключа отметь Model capabilities.\n${message || ''}`;
  }
  if (/model.*(not found|does not exist|access)/i.test(text)) {
    return `Модель недоступна для твоего ключа/проекта. Выбери другую модель в селекте.\n${message || ''}`;
  }
  // Не-chat модели: instruct/embedding/whisper/tts — их нельзя слать в /v1/chat/completions.
  if (/not a chat model|v1\/completions|chat\.completions.*(unsupported|not supported)/i.test(text)) {
    return `Выбранная модель не поддерживает чат (instruct/embedding/tts/whisper).\n` +
      `Возьми модель с буквами «chat» или из семейства gpt-4*/gpt-5*/o3/o4-mini.\n` +
      (message ? `\nОригинал ошибки: ${message}` : '');
  }
  if (/context.length|maximum context|too many tokens/i.test(text)) {
    return `Слишком длинный контекст для этой модели. Начни новый чат или выбери модель с большим окном.\n${message || ''}`;
  }
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(text)) {
    return `Нет связи с API. Проверь интернет / VPN / прокси.\n${message || ''}`;
  }
  // Дефолт — показываем хотя бы вычлененное message если есть.
  return message ? `Ошибка API: ${message}` : text;
}

function addCopyButton(msgEl) {
  const btn = document.createElement('button');
  btn.className = 'msg-copy-btn';
  btn.title = 'Копировать сообщение';
  btn.textContent = '⧉';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const body = msgEl.querySelector('.body');
    const text = body?.innerText || body?.textContent || '';
    try { await navigator.clipboard.writeText(text); } catch (_) {}
    btn.classList.add('copied');
    btn.textContent = '✓';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⧉'; }, 1200);
  });
  msgEl.appendChild(btn);
}

function setChatTitleUI(title) {
  const el = $('tab-current-name');
  if (el) el.textContent = title || 'Новый чат';
  updateChatCarousel().catch(() => {});
}

async function updateChatCarousel() {
  const prevTab = $('tab-prev'), nextTab = $('tab-next');
  if (!prevTab || !nextTab) return;
  let items = [];
  try { items = await window.app.chats.list(); } catch (_) { items = []; }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  // Только сохранённые чаты (count > 0). Текущий новый чат не в списке.
  const sorted = items.filter(it => it.id !== state.chatId);
  // Индекс текущего в полном списке (если он там есть).
  const currIdx = items.findIndex(it => it.id === state.chatId);
  let prev = null, next = null;
  if (currIdx >= 0) {
    prev = items[currIdx - 1] || null; // более свежий
    next = items[currIdx + 1] || null; // более старый
  } else {
    // Новый несохранённый чат — справа от него «нет ничего», слева — самый свежий.
    next = items[0] || null;
  }
  if (prev) {
    prevTab.style.display = '';
    $('tab-prev-name').textContent = prev.title || 'Без названия';
    prevTab.dataset.chatId = prev.id;
  } else prevTab.style.display = 'none';
  if (next) {
    nextTab.style.display = '';
    $('tab-next-name').textContent = next.title || 'Без названия';
    nextTab.dataset.chatId = next.id;
  } else nextTab.style.display = 'none';
}

async function navigateChat(dir) {
  const tab = dir < 0 ? $('tab-prev') : $('tab-next');
  const id = tab?.dataset?.chatId;
  if (!id) return;
  await loadChatById(id);
}

function newChat() {
  state.messages = [];
  state.chatId = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.chatTitle = 'Новый чат';
  state.agentChanges = [];
  state.agentCwd = null;
  setChatTitleUI(state.chatTitle);
  if ($('messages')) $('messages').innerHTML = '';
  updateChangesBar();
  setStatus('Новый чат');
}

async function persistChat() {
  if (!state.chatId) state.chatId = 'c_' + Date.now().toString(36);
  try {
    await window.app.chats.save({
      id: state.chatId,
      title: state.chatTitle || (state.messages[0]?.content?.toString().slice(0, 50) || 'Без названия'),
      updatedAt: Date.now(),
      messages: state.messages,
      agentChanges: state.agentChanges
    });
  } catch (_) {}
  updateChatCarousel().catch(() => {});
}

async function openHistoryModal() {
  const list = $('history-list'); const modal = $('history-modal');
  if (!list || !modal) return;
  list.innerHTML = '<div style="color:var(--fg2);padding:8px">Загрузка...</div>';
  modal.classList.add('open');
  let items = [];
  try { items = await window.app.chats.list(); } catch (e) {
    list.innerHTML = '<div style="color:var(--error);padding:8px">Ошибка: ' + escapeHtml(String(e?.message || e)) + '</div>';
    return;
  }
  if (!items?.length) { list.innerHTML = '<div style="color:var(--fg2);padding:8px">Нет чатов</div>'; return; }
  list.innerHTML = '';
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const date = it.updatedAt ? new Date(it.updatedAt).toLocaleString() : '';
    row.innerHTML = '<div style="flex:1;min-width:0;cursor:pointer">'
      + '<div style="color:var(--fg);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(it.title || 'Без названия') + '</div>'
      + '<div style="color:var(--fg2);font-size:11px">' + escapeHtml(date) + ' · ' + (it.count || 0) + ' сообщ.</div>'
      + '</div>'
      + '<div class="actions"><button data-del="' + escapeHtml(it.id) + '">×</button></div>';
    row.firstElementChild.addEventListener('click', () => loadChatById(it.id));
    const delBtn = row.querySelector('button[data-del]');
    if (delBtn) delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await window.app.chats.delete(it.id); } catch (_) {}
      openHistoryModal();
    });
    list.appendChild(row);
  }
}

async function loadChatById(id) {
  const chat = await window.app.chats.get(id);
  if (!chat) return;
  state.chatId = chat.id;
  state.chatTitle = chat.title || 'Без названия';
  state.messages = chat.messages || [];
  state.agentChanges = chat.agentChanges || [];
  setChatTitleUI(state.chatTitle);
  const box = $('messages'); if (box) {
    box.innerHTML = '';
    for (const m of state.messages) {
      if (m.role === 'system') continue;
      const el = document.createElement('div');
      el.className = 'msg ' + m.role;
      const label = m.role === 'user' ? '' : m.role === 'assistant' ? '' : 'ошибка';
      const labelHtml = label ? '<div class="role">' + label + '</div>' : '';
      el.innerHTML = labelHtml + '<div class="body"></div>';
      const c = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.map(p => p?.text || '').join('') : '';
      el.querySelector('.body').textContent = c;
      if (m.role === 'assistant') addCopyButton(el);
      box.appendChild(el);
    }
    box.scrollTop = box.scrollHeight;
  }
  updateChangesBar();
  $('history-modal').classList.remove('open');
  setStatus('Загружен: ' + state.chatTitle);
}

// ============================================================================
// Контекст (чипы над input). Добавляются через Ctrl+L или правый-клик в дереве.
// ============================================================================

function renderContextChips() {
  const host = $('ctx-chips');
  if (!host) return;
  host.innerHTML = '';
  const items = state.contextFiles || [];
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    const chip = document.createElement('span');
    chip.className = 'ctx-chip' + (c.kind === 'image' ? ' ctx-chip-img' : '');
    if (c.kind === 'image') {
      chip.innerHTML = '<img class="ctx-chip-thumb" src="data:' + (c.mimeType || 'image/png') + ';base64,' + c.data + '">'
        + '<span class="ctx-chip-label">' + escapeHtml(c.name || 'image') + '</span>'
        + '<button class="ctx-chip-x" title="Убрать">×</button>';
    } else {
      const label = c.kind === 'cmd' ? 'cmd' : (c.name || (c.path || '').split(/[\\/]/).pop() || '?');
      const range = (c.fromLine && c.toLine)
        ? (c.kind === 'text' ? ` (${c.fromLine}-${c.toLine})` : ` ${c.fromLine}-${c.toLine}`)
        : (c.kind === 'text' && c.lineCount ? ` (${c.lineCount})` : '');
      chip.innerHTML = '<span class="ctx-chip-label">@' + escapeHtml(label) + escapeHtml(range) + '</span>'
        + '<button class="ctx-chip-x" title="Убрать">×</button>';
    }
    chip.querySelector('.ctx-chip-x').addEventListener('click', () => {
      state.contextFiles.splice(i, 1);
      renderContextChips();
    });
    host.appendChild(chip);
  }
}

// Парсит строку "name 12-340" или "name" в {name, from, to}. Возвращает null если пусто.
function parseContextSpec(s) {
  const m = String(s || '').trim().match(/^(.+?)(?:\s+(\d+)\s*-\s*(\d+))?\s*$/);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  const from = m[2] ? parseInt(m[2], 10) : null;
  const to = m[3] ? parseInt(m[3], 10) : null;
  return { name, from, to };
}

// Захватывает буфер активного терминала в текст. Возвращает массив строк.
function captureTerminalText() {
  const inst = (typeof termState !== 'undefined') ? termState.instances?.find(x => x.id === termState.activeId) : null;
  if (!inst?.term) return [];
  // xterm.js хранит буфер через term.buffer.active
  const buf = inst.term.buffer?.active;
  if (!buf) return [];
  const lines = [];
  const len = buf.length;
  for (let i = 0; i < len; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    lines.push(line.translateToString(true));
  }
  // Обрезаем хвостовые пустые строки.
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

async function openAddContextDialog() {
  // Простое модальное окно через uiPrompt-подобную логику.
  // Если uiPrompt не определён — fall back на window.prompt.
  let input;
  try {
    input = await uiPrompt('Контекст: имя файла или "cmd"; диапазон "имя 112-250"', '');
  } catch (_) {
    input = window.prompt('Контекст: имя файла или "cmd"; диапазон "имя 112-250"', '');
  }
  if (!input) return;
  const spec = parseContextSpec(input);
  if (!spec) return;

  state.contextFiles = state.contextFiles || [];
  if (/^cmd$/i.test(spec.name)) {
    state.contextFiles.push({ kind: 'cmd', name: 'cmd', fromLine: spec.from, toLine: spec.to });
  } else {
    // Файл — резолвим путь через дерево или относительно rootDir.
    let p = spec.name;
    if (!/^[a-z]:[\\/]/i.test(p) && state.rootDir) {
      p = (state.rootDir.endsWith('\\') || state.rootDir.endsWith('/'))
        ? state.rootDir + p
        : state.rootDir + '\\' + p;
    }
    const exists = await window.app.exists(p).catch(() => false);
    if (!exists) {
      setStatus('Файл не найден: ' + p);
      return;
    }
    state.contextFiles.push({ kind: 'file', path: p, name: spec.name.split(/[\\/]/).pop(), fromLine: spec.from, toLine: spec.to });
  }
  renderContextChips();
  setStatus('Добавлено в контекст');
}

// Читает содержимое всех чипов и возвращает блок-текст для prepend перед сообщением.
async function buildContextBlock() {
  const items = state.contextFiles || [];
  if (!items.length) return '';
  const parts = [];
  for (const c of items) {
    let body = '';
    let label = '';
    if (c.kind === 'image') {
      continue; // картинки идут отдельно как image-parts, в текстовом контексте не нужны.
    } else if (c.kind === 'cmd') {
      const lines = captureTerminalText();
      const from = c.fromLine && c.fromLine > 0 ? c.fromLine - 1 : 0;
      const to = c.toLine && c.toLine > 0 ? c.toLine : lines.length;
      body = lines.slice(from, to).join('\n');
      label = 'cmd' + (c.fromLine ? ` lines=${c.fromLine}-${c.toLine || lines.length}` : '');
    } else if (c.kind === 'text') {
      body = c.text || '';
      label = c.name || 'selection';
    } else {
      const r = await window.app.read(c.path);
      if (r?.error) continue;
      const text = r.content || '';
      if (c.fromLine && c.toLine) {
        const lines = text.split(/\r?\n/);
        const from = Math.max(0, c.fromLine - 1);
        const to = Math.min(lines.length, c.toLine);
        body = lines.slice(from, to).join('\n');
        label = `${c.path} lines=${c.fromLine}-${c.toLine}`;
      } else {
        body = text;
        label = c.path;
      }
    }
    parts.push('<context source="' + label + '">\n' + body + '\n</context>');
  }
  return '[Контекст]\n' + parts.join('\n') + '\n[/Контекст]\n\n';
}

function stopChat() {
  state.agentStopped = true;
  if (state.currentStreamId) window.app.abort(state.currentStreamId).catch(() => {});
  state.currentStreamId = null;
  state.streamHandledLocally = false;
  state.agentBusy = false;
  if ($('btn-send')) $('btn-send').style.display = '';
  if ($('btn-stop')) $('btn-stop').style.display = 'none';
  setAgentStatus('');
}

let _agentStatusStart = 0;
let _agentStatusTimer = null;
function setAgentStatus(text) {
  const bar = $('agent-status');
  if (!bar) return;
  if (!text) {
    bar.classList.remove('open');
    if (_agentStatusTimer) { clearInterval(_agentStatusTimer); _agentStatusTimer = null; }
    const t = bar.querySelector('.agent-status-text'); if (t) t.textContent = '';
    const tm = bar.querySelector('.agent-status-time'); if (tm) tm.textContent = '';
    return;
  }
  bar.classList.add('open');
  const t = bar.querySelector('.agent-status-text'); if (t) t.textContent = text;
  _agentStatusStart = Date.now();
  if (_agentStatusTimer) clearInterval(_agentStatusTimer);
  const tick = () => {
    const s = Math.floor((Date.now() - _agentStatusStart) / 1000);
    const tm = bar.querySelector('.agent-status-time');
    if (tm) tm.textContent = s >= 60 ? `${Math.floor(s / 60)}м ${s % 60}с` : `${s}с`;
  };
  tick();
  _agentStatusTimer = setInterval(tick, 1000);
}

const TOOL_STATUS_LABEL = {
  read_file: 'Читаю файл',
  write_file: 'Пишу файл',
  edit_file: 'Правлю файл',
  list_dir: 'Смотрю папку',
  mkdir: 'Создаю папку',
  delete: 'Удаляю файл',
  run: 'Запускаю команду',
  remember: 'Запоминаю',
  grep: 'Ищу по проекту'
};

function makeStreamId() {
  return 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function sendChat() {
  if (state.agentBusy || state.currentStreamId) {
    setStatus('Подожди — запрос ещё выполняется');
    return;
  }
  const input = $('chat-input');
  const text = (input?.value || '').trim();
  if (!text) return;
  input.value = '';

  const providerId = $('provider-select')?.value;
  const model = $('model-select')?.value;
  const key = state.settings?.keys?.[providerId];
  if (!key) { pushMessage('error', 'Нет API-ключа для ' + providerId + '. Открой Настройки.'); return; }

  if (state.messages.length === 0) {
    state.chatTitle = text.slice(0, 50) || 'Новый чат';
    setChatTitleUI(state.chatTitle);
  }

  // Подмешиваем контекст (чипы) в начало сообщения, если есть.
  const ctxBlock = await buildContextBlock().catch(() => '');
  const images = (state.contextFiles || []).filter(c => c.kind === 'image');
  let userContent;
  if (images.length) {
    // Multi-part content: текст + картинки. API-слой (toOpenAIMessages/toAnthropicMessages/toGeminiContents)
    // знает как сериализовать такую структуру в формат каждого провайдера.
    const parts = [];
    const txt = (ctxBlock || '') + text;
    if (txt) parts.push({ type: 'text', text: txt });
    for (const img of images) {
      parts.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    }
    userContent = parts;
  } else {
    userContent = ctxBlock ? (ctxBlock + text) : text;
  }
  pushMessage('user', userContent);
  // Чипы используются один раз — после отправки сбрасываем, как в Cursor.
  if (state.contextFiles && state.contextFiles.length) {
    state.contextFiles = [];
    renderContextChips();
  }
  state.agentStopped = false;
  if ($('btn-send')) $('btn-send').style.display = 'none';
  if ($('btn-stop')) $('btn-stop').style.display = '';

  try {
    if (state.agentMode) await runAgentLoop(providerId, key, model);
    else await runAskOnce(providerId, key, model);
  } catch (e) {
    if (!state.agentStopped) {
      pushMessage('error', friendlyApiError(String(e?.message || e), providerId));
    }
  } finally {
    stopChat();
    persistChat();
  }
}

function buildMessagesForApi() {
  const out = [];
  for (const m of state.messages) {
    if (m.role === 'error') continue;
    let content = m.content;
    if (typeof content === 'string') { if (!content.trim()) continue; out.push({ role: m.role, content }); }
    else if (Array.isArray(content)) out.push({ role: m.role, content });
  }
  return out;
}

async function runAskOnce(providerId, key, model) {
  const sid = makeStreamId();
  state.currentStreamId = sid;
  state.streamHandledLocally = true;
  setAgentStatus('Думаю');
  const replyEl = pushMessage('assistant', '');
  const body = replyEl.querySelector('.body');
  let buf = '';
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { try { offC(); offD(); offE(); } catch (_) {} state.streamHandledLocally = false; };
    const offC = window.app.onChunk(({ id, text }) => {
      if (id !== sid || settled) return;
      buf += text;
      body.textContent = buf;
      scrollIfPinned();
    });
    const offD = window.app.onDone(({ id }) => {
      if (id !== sid || settled) return;
      settled = true; cleanup();
      state.messages[state.messages.length - 1].content = buf;
      body.innerHTML = renderMarkdown(buf);
      hookupMarkdown(body);
      setAgentStatus('');
      resolve();
    });
    const offE = window.app.onError(({ id, error }) => {
      if (id !== sid || settled) return;
      settled = true; cleanup(); reject(new Error(error));
    });
    const identityMsg = { role: 'system', content: modelIdentity() };
    window.app.chat({
      id: sid, providerId, key, model,
      messages: [identityMsg, ...buildMessagesForApi()],
      extras: state.settings?.extras?.[providerId] || {},
      webSearch: !!state.webSearch && providerSupportsWebSearch(providerId)
    }).catch(reject);
  });
}

// === Ctrl+L: положить выделение из терминала/редактора в чат как контекст-чип ===
function focusChatInput() {
  const app = document.getElementById('app');
  if (app && app.classList.contains('chat-hidden')) {
    app.classList.remove('chat-hidden');
    $('btn-toggle-chat')?.classList.add('active');
  }
  const ci = $('chat-input');
  if (!ci) return;
  ci.focus();
  try {
    const v = ci.value || '';
    ci.setSelectionRange(v.length, v.length);
  } catch (_) {}
}

function ctrlLAddSelection() {
  // Возвращает true если чип был добавлен, false если просто перевели фокус на чат.
  // 1. Терминал в приоритете: если активный xterm имеет выделение — берём его.
  const inst = (typeof termState !== 'undefined') ? termState.instances?.find(x => x.id === termState.activeId) : null;
  let termSelected = '';
  try { if (inst?.term?.hasSelection?.()) termSelected = inst.term.getSelection() || ''; } catch (_) {}
  if (termSelected && termSelected.trim()) {
    state.contextFiles = state.contextFiles || [];
    const lineCount = termSelected.split(/\r?\n/).length;
    const shellLabel = inst?.shell || 'terminal';
    let fromLine = null, toLine = null;
    try {
      const pos = inst.term.getSelectionPosition?.();
      if (pos && pos.start && pos.end) {
        fromLine = (pos.start.y | 0) + 1;
        toLine = (pos.end.y | 0) + 1;
        if (toLine < fromLine) { const t = fromLine; fromLine = toLine; toLine = t; }
      }
    } catch (_) {}
    const chip = { kind: 'text', text: termSelected, name: shellLabel, lineCount };
    if (fromLine && toLine) { chip.fromLine = fromLine; chip.toLine = toLine; }
    state.contextFiles.push(chip);
    renderContextChips();
    focusChatInput();
    const rangeStr = (fromLine && toLine) ? `${fromLine}-${toLine}` : `${lineCount} стр.`;
    setStatus('Добавлено в контекст: ' + shellLabel + ' (' + rangeStr + ')');
    return true;
  }
  // 2. Редактор: если есть непустая селекция в Monaco — добавляем как файл с диапазоном строк.
  if (state.editor && state.activeFile) {
    let sel = null;
    try { sel = state.editor.getSelection?.(); } catch (_) {}
    if (sel && (sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn)) {
      state.contextFiles = state.contextFiles || [];
      const fileName = state.activeFile.split(/[\\/]/).pop();
      state.contextFiles.push({
        kind: 'file',
        path: state.activeFile,
        name: fileName,
        fromLine: sel.startLineNumber,
        toLine: sel.endLineNumber
      });
      renderContextChips();
      focusChatInput();
      setStatus('Добавлено в контекст: ' + fileName + ' (' + sel.startLineNumber + '-' + sel.endLineNumber + ')');
      return true;
    }
  }
  // 3. Произвольный DOM-текст: выделение в сообщениях чата, дереве файлов, любых текстовых нодах.
  // Исключаем input-поля (там селекция своя, и копировать содержимое чата в чат бессмысленно).
  try {
    const ds = window.getSelection?.();
    const text = ds ? String(ds.toString() || '') : '';
    if (text && text.trim()) {
      const anchor = ds.anchorNode && (ds.anchorNode.nodeType === 3 ? ds.anchorNode.parentElement : ds.anchorNode);
      const insideInput = anchor && anchor.closest && anchor.closest('#chat-input, #inline-text, #term-cmd-input, input, textarea');
      if (!insideInput) {
        state.contextFiles = state.contextFiles || [];
        const lineCount = text.split(/\r?\n/).length;
        // Попробуем угадать «откуда» — для сообщений чата подпишем как 'chat'.
        let label = 'selection';
        if (anchor && anchor.closest) {
          if (anchor.closest('#messages')) label = 'chat';
          else if (anchor.closest('#file-tree, #sidebar')) label = 'tree';
        }
        state.contextFiles.push({ kind: 'text', text, name: label, lineCount });
        renderContextChips();
        focusChatInput();
        setStatus('Добавлено в контекст: ' + label + ' (' + lineCount + ' стр.)');
        // Сбросим выделение чтобы при повторном Ctrl+L не добавилось снова.
        try { ds.removeAllRanges(); } catch (_) {}
        return true;
      }
    }
  } catch (_) {}
  // 4. Нет выделения нигде — просто открываем чат.
  focusChatInput();
  return false;
}

// === Ctrl+K: маршрутизация по фокусу — редактор → inline-правка, иначе → терминальный командный промпт ===
function openCtrlKPrompt() {
  if ($('inline-prompt')?.classList.contains('open')) return;
  if ($('term-cmd-prompt')?.classList.contains('open')) return;
  const editorHasFocus = !!(state.editor && state.editor.hasTextFocus && state.editor.hasTextFocus());
  if (editorHasFocus) {
    let sel = null;
    try { sel = state.editor.getSelection?.(); } catch (_) {}
    if (sel && (sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn)) {
      openInlineEditPrompt();
      return;
    }
    setStatus('Выделите код для правки через Ctrl+K');
    return;
  }
  openTermCmdPrompt();
}

// === Inline-правка файла через Ctrl+K в редакторе ===
const _inlineEdit = {
  selection: null, selText: '', fileLang: '', filePath: null,
  response: '', generating: false, streamId: null
};

function openInlineEditPrompt() {
  if (!state.editor || !state.activeFile) return;
  let sel = null;
  try { sel = state.editor.getSelection(); } catch (_) {}
  if (!sel) return;
  const isEmpty = sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
  if (isEmpty) return;
  const model = state.editor.getModel?.();
  if (!model) return;
  let selText = '';
  try { selText = model.getValueInRange(sel) || ''; } catch (_) {}
  if (!selText) return;
  const entry = state.openFiles.get(state.activeFile);
  _inlineEdit.selection = {
    startLineNumber: sel.startLineNumber,
    startColumn: sel.startColumn,
    endLineNumber: sel.endLineNumber,
    endColumn: sel.endColumn
  };
  _inlineEdit.selText = selText;
  _inlineEdit.fileLang = entry?.lang || 'plaintext';
  _inlineEdit.filePath = state.activeFile;
  _inlineEdit.response = '';
  _inlineEdit.generating = false;
  const ta = $('inline-text'); if (ta) ta.value = '';
  const out = $('inline-output'); if (out) { out.style.display = 'none'; out.textContent = ''; }
  const submit = $('inline-submit');
  if (submit) { submit.textContent = 'Сгенерировать'; submit.disabled = false; }
  const hint = $('inline-hint');
  if (hint) hint.textContent = 'Правка ' + (_inlineEdit.filePath.split(/[\\/]/).pop()) + ' · ' + sel.startLineNumber + '-' + sel.endLineNumber;
  $('inline-prompt')?.classList.add('open');
  setTimeout(() => $('inline-text')?.focus(), 30);
}

function closeInlineEditPrompt() {
  if (_inlineEdit.streamId) {
    try { window.app.abort(_inlineEdit.streamId); } catch (_) {}
    _inlineEdit.streamId = null;
  }
  _inlineEdit.selection = null;
  _inlineEdit.selText = '';
  _inlineEdit.response = '';
  _inlineEdit.generating = false;
  _inlineEdit.filePath = null;
  $('inline-prompt')?.classList.remove('open');
}

async function inlineEditAction() {
  if (_inlineEdit.generating) return;
  if (_inlineEdit.response) { applyInlineEdit(); return; }
  await generateInlineEdit();
}

async function generateInlineEdit() {
  const instruction = ($('inline-text')?.value || '').trim();
  if (!instruction) { $('inline-text')?.focus(); return; }
  if (!_inlineEdit.selection || !_inlineEdit.filePath) return;
  const providerId = $('provider-select')?.value;
  const model = $('model-select')?.value;
  const key = state.settings?.keys?.[providerId];
  const out = $('inline-output');
  const submit = $('inline-submit');
  if (!key) {
    if (out) { out.style.display = 'block'; out.textContent = 'Нет API-ключа для ' + providerId; }
    return;
  }
  _inlineEdit.generating = true;
  _inlineEdit.response = '';
  if (out) { out.style.display = 'block'; out.textContent = '…'; }
  if (submit) submit.disabled = true;
  const sys = `Ты — редактор кода. Тебе дан фрагмент на языке ${_inlineEdit.fileLang} и инструкция от пользователя.
Верни ТОЛЬКО изменённый код, без объяснений, без markdown-блоков (\`\`\`), без префиксов типа "вот код:".
Сохрани отступы и стиль исходного фрагмента. Возвращаемый текст заменит выделенный фрагмент 1:1.`;
  const user = 'Исходный фрагмент:\n' + _inlineEdit.selText + '\n\nИнструкция: ' + instruction;
  const sid = makeStreamId();
  _inlineEdit.streamId = sid;
  let buf = '';
  await new Promise((resolve) => {
    let settled = false;
    const cleanup = () => { try { offC(); offD(); offE(); } catch (_) {} };
    const offC = window.app.onChunk(({ id, text: chunk }) => {
      if (id !== sid || settled) return;
      buf += chunk;
      if (out) out.textContent = buf;
    });
    const offD = window.app.onDone(({ id }) => {
      if (id !== sid || settled) return;
      settled = true; cleanup(); resolve();
    });
    const offE = window.app.onError(({ id, error }) => {
      if (id !== sid || settled) return;
      settled = true; cleanup();
      if (out) out.textContent = 'Ошибка: ' + error;
      resolve();
    });
    window.app.chat({
      id: sid, providerId, key, model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      extras: state.settings?.extras?.[providerId] || {},
      webSearch: false
    }).catch((e) => {
      if (settled) return;
      settled = true; cleanup();
      if (out) out.textContent = 'Ошибка: ' + (e?.message || e);
      resolve();
    });
  });
  _inlineEdit.streamId = null;
  let result = buf.trim();
  result = result.replace(/^```[\w-]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  _inlineEdit.response = result;
  if (out) out.textContent = result || '(пусто)';
  if (submit) {
    submit.textContent = 'Применить';
    submit.disabled = !result;
  }
  _inlineEdit.generating = false;
}

function applyInlineEdit() {
  const sel = _inlineEdit.selection;
  const text = _inlineEdit.response;
  if (!sel || !text || !state.editor) return;
  if (state.activeFile !== _inlineEdit.filePath) {
    setStatus('Активный файл изменился — правка отменена');
    closeInlineEditPrompt();
    return;
  }
  const RangeCls = state.monaco?.Range || window.monaco?.Range;
  if (!RangeCls) { setStatus('Monaco Range недоступен'); closeInlineEditPrompt(); return; }
  const range = new RangeCls(sel.startLineNumber, sel.startColumn, sel.endLineNumber, sel.endColumn);
  state.editor.executeEdits('inline-ai-edit', [{ range, text, forceMoveMarkers: true }]);
  state.editor.focus();
  closeInlineEditPrompt();
  setStatus('Правка применена. Ctrl+Z — отменить.');
}

// === Ctrl+K: промпт «команда для терминала» ===
const _termCmd = { generated: '', generating: false, streamId: null };

function openTermCmdPrompt() {
  if (_termCmd.streamId) {
    try { window.app.abort(_termCmd.streamId); } catch (_) {}
    _termCmd.streamId = null;
  }
  const wasOpen = $('terminal-panel')?.classList.contains('open');
  if (!wasOpen) { try { toggleTerminal(); } catch (_) {} }
  const el = $('term-cmd-prompt');
  if (!el) return;
  el.classList.add('open');
  const input = $('term-cmd-input');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 30); }
  const out = $('term-cmd-output');
  if (out) { out.style.display = 'none'; out.textContent = ''; }
  const ins = $('term-cmd-insert'); if (ins) ins.disabled = true;
  const run = $('term-cmd-run'); if (run) run.disabled = true;
  _termCmd.generated = '';
  _termCmd.generating = false;
}

function closeTermCmdPrompt() {
  if (_termCmd.streamId) {
    try { window.app.abort(_termCmd.streamId); } catch (_) {}
    _termCmd.streamId = null;
  }
  _termCmd.generating = false;
  $('term-cmd-prompt')?.classList.remove('open');
}

function cleanupGeneratedCommand(raw) {
  let cmd = String(raw || '').trim();
  // Снять fenced markdown-блоки если модель проигнорила инструкцию.
  cmd = cmd.replace(/^```[\w-]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  // Снять префиксы $ > # PS> и т.п.
  cmd = cmd.replace(/^(?:\$|>|#|PS\s*[A-Z]:[^>]*>)\s*/i, '').trim();
  // Если несколько строк — берём только первую непустую (cmd.exe строки разделяются &).
  // Но многострочные heredoc-сценарии сохраняем как есть, если есть && или строки выглядят как продолжение.
  // Минимальное правило: убираем хвостовые пустые строки.
  cmd = cmd.replace(/\s+$/g, '');
  return cmd;
}

async function generateTermCommand() {
  if (_termCmd.generating) return;
  const input = $('term-cmd-input');
  const out = $('term-cmd-output');
  const text = (input?.value || '').trim();
  if (!text) { input?.focus(); return; }
  const providerId = $('provider-select')?.value;
  const model = $('model-select')?.value;
  const key = state.settings?.keys?.[providerId];
  if (!key) {
    if (out) { out.style.display = 'block'; out.textContent = 'Нет API-ключа для ' + providerId + '. Открой Настройки.'; }
    return;
  }
  _termCmd.generating = true;
  if (out) { out.style.display = 'block'; out.textContent = '…'; }
  const insBtn = $('term-cmd-insert'); if (insBtn) insBtn.disabled = true;
  const runBtn = $('term-cmd-run'); if (runBtn) runBtn.disabled = true;
  const genBtn = $('term-cmd-gen'); if (genBtn) genBtn.disabled = true;

  const cwd = state.agentCwd || state.rootDir || '';
  const sys = `Ты — генератор shell-команд для cmd.exe на Windows.
Текущая папка: ${cwd || '(не открыта)'}.

ПРАВИЛА:
- Выведи ТОЛЬКО команду — одну строку без объяснений.
- НЕ используй markdown-блоки (\`\`\`). Никаких префиксов типа $, >, # перед командой.
- Используй cmd-синтаксис Windows: dir, type, copy, move, rd, md, && и т.п.
- Если нужно несколько шагов — соедини через && (выполняется при успехе) или & (всегда).
- Если запрос абсурдный или не на команду — выведи :: краткое пояснение (это cmd-комментарий).`;

  const sid = makeStreamId();
  _termCmd.streamId = sid;
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: text }];
  let buf = '';
  await new Promise((resolve) => {
    let settled = false;
    const cleanup = () => { try { offC(); offD(); offE(); } catch (_) {} };
    const offC = window.app.onChunk(({ id, text: chunk }) => {
      if (id !== sid || settled) return;
      buf += chunk;
      if (out) out.textContent = buf.trim();
    });
    const offD = window.app.onDone(({ id }) => {
      if (id !== sid || settled) return;
      settled = true; cleanup(); resolve();
    });
    const offE = window.app.onError(({ id, error }) => {
      if (id !== sid || settled) return;
      settled = true; cleanup();
      if (out) out.textContent = 'Ошибка: ' + error;
      resolve();
    });
    window.app.chat({
      id: sid, providerId, key, model, messages,
      extras: state.settings?.extras?.[providerId] || {},
      webSearch: false
    }).catch((e) => {
      if (settled) return;
      settled = true; cleanup();
      if (out) out.textContent = 'Ошибка: ' + (e?.message || e);
      resolve();
    });
  });
  _termCmd.streamId = null;
  const cmd = cleanupGeneratedCommand(buf);
  _termCmd.generated = cmd;
  if (out) out.textContent = cmd || '(пусто)';
  const ok = !!cmd && !/^Ошибка:/.test(cmd);
  if (insBtn) insBtn.disabled = !ok;
  if (runBtn) runBtn.disabled = !ok;
  if (genBtn) genBtn.disabled = false;
  _termCmd.generating = false;
}

async function insertTermCommand(andRun) {
  const cmd = _termCmd.generated;
  if (!cmd) return;
  const id = termState.activeId;
  if (!id) { setStatus('Нет активного терминала'); return; }
  try {
    if (andRun) {
      await window.app.term.execLine(id, cmd);
    } else {
      await window.app.term.write(id, cmd);
    }
    closeTermCmdPrompt();
    setTimeout(() => {
      const inst = termState.instances.find(x => x.id === id);
      try { inst?.term?.focus(); } catch (_) {}
    }, 30);
  } catch (e) {
    setStatus('Ошибка вставки в терминал: ' + (e?.message || e));
  }
}

function modelIdentity() {
  const providerId = $('provider-select')?.value || state.settings.lastProvider || '';
  const model = $('model-select')?.value || state.settings.lastModel || '';
  const provName = state.providers?.[providerId]?.name || providerId || 'неизвестный';
  return `Ты — модель "${model}" от провайдера ${provName}, работаешь через его API в десктоп-редакторе Doomsheek code (Electron, Windows).
Если пользователь спросит "какая ты модель?", "кто ты?", "what model are you" — отвечай конкретно: "${model}" (провайдер ${provName}). НЕ говори "это скрыто" или "не знаю". Пользователь сам выбрал тебя из списка моделей в этом редакторе.`;
}

const AGENT_SYSTEM = (cwd, gh) => {
  const memBlock = (state.memory && state.memory.length)
    ? '\n═══ ПАМЯТЬ ═══\n(заметки из прошлых разговоров)\n' +
      state.memory.map((n, i) => '- ' + (typeof n === 'string' ? n : n.text)).join('\n') +
      '\nЕсли что-то здесь устарело или неверно — не используй.\n'
    : '';
  // Реальное состояние GitHub-привязки — подставляется в блок GIT и GITHUB ниже.
  let githubBlock;
  if (gh?.connected && gh?.hasToken) {
    githubBlock =
`У пользователя подключён GitHub-аккаунт **${gh.username}** через credential helper.
Это значит \`git push / pull / clone\` через HTTPS работают без запроса пароля.
user.name и user.email тоже выставлены, \`git commit\` пройдёт сразу.`;
  } else if (gh?.connected) {
    githubBlock =
`Аккаунт GitHub привязан: **${gh.username}**, но credential helper НЕ настроен (token не сохранён).
\`git commit\` работает (user.name/email есть). \`git push\` через HTTPS попросит пароль —
если падает auth, сообщи пользователю: «Нужно подключить GitHub с токеном через Git-таб → Подключить» или настроить SSH.`;
  } else {
    githubBlock =
`GitHub не подключён. Команды \`git push\` / \`pull\` через HTTPS будут падать с auth error.
Если пользователь просит запушить — сначала сообщи: «Сначала подключи GitHub через Git-таб (🌐 Авторизация через браузер)».`;
  }
  return `${modelIdentity()}
${memBlock}
Ты — агент в редакторе кода Doomsheek code (Windows). У тебя есть РЕАЛЬНЫЙ доступ к диску через tool-вызовы.

ФОРМАТ (ровно один tool на ответ, потом жди tool_result):

<tool name="read_file"><path>D:\\\\полный\\\\путь</path></tool>
<tool name="write_file"><path>D:\\\\путь</path><content>СЫРОЕ_СОДЕРЖИМОЕ_БЕЗ_HTML_СУЩНОСТЕЙ</content></tool>
<tool name="edit_file"><path>D:\\\\путь</path><old_string>точный кусок текста из файла</old_string><new_string>чем заменить</new_string></tool>
<tool name="delete"><path>D:\\\\путь</path></tool>
<tool name="list_dir"><path>D:\\\\путь</path></tool>
<tool name="mkdir"><path>D:\\\\путь</path></tool>
<tool name="grep"><pattern>regex</pattern><glob>*.js</glob></tool>
<tool name="run"><command>shell-команда (cmd.exe на Windows)</command></tool>
<tool name="remember"><note>факт который стоит запомнить навсегда (короткой строкой)</note></tool>

ПРАВИЛА:
- В одном ответе только один <tool>. Без пояснений до или после.
- В <content>/<old_string>/<new_string> пиши код КАК ЕСТЬ: настоящие < > & и т.п. НИКОГДА не пиши &lt; &gt; &amp;.
- Пути абсолютные с двойными слэшами.
- Когда задача выполнена — напиши краткий итог пользователю БЕЗ <tool>.
- НЕ ПЕРЕЗАПИСЫВАЙ файлы редактора (D:\\\\elProject\\\\src\\\\renderer.js, main.js, preload.js, styles.css, index.html).

═══ ПРАВКА vs ЗАПИСЬ ═══

write_file — ПОЛНЫЙ перезапис файла. Дорого по токенам и опасно для больших файлов: один пропущенный символ затирает всё.
edit_file — ТОЧЕЧНАЯ замена. Используй для правки существующих файлов. Заменяет <old_string> на <new_string>.

КОГДА ЧТО:
- Создаёшь НОВЫЙ файл — write_file.
- Меняешь существующий файл — edit_file (всегда, даже если файл маленький).
- Хочешь заменить весь существующий файл целиком — write_file, но это редко правильный выбор.

ПРАВИЛА edit_file:
- <old_string> должен встречаться в файле РОВНО ОДИН РАЗ. Если встречается несколько — добавь больше контекста (строки выше/ниже) чтобы стал уникальным.
- Если надо заменить все вхождения сразу — добавь <replace_all>true</replace_all>.
- <old_string> должен совпадать с файлом ПОБАЙТОВО, включая пробелы, табы и переносы строк. Прочитай файл через read_file сначала и скопируй точный кусок.
- Если получишь ошибку "old_string не найден" или "встречается N раз" — прочитай файл заново и скорректируй фрагмент.

═══ ПОИСК ПО ПРОЕКТУ ═══

grep — поиск regex по всем файлам открытой папки. Игнорирует node_modules, .git, dist, build и подобный мусор.

<tool name="grep"><pattern>function\\s+sendChat</pattern></tool>
<tool name="grep"><pattern>TODO</pattern><glob>*.ts</glob></tool>
<tool name="grep"><pattern>useState</pattern><path>D:\\\\proj\\\\src</path><glob>*.jsx</glob></tool>

КОГДА: ищешь где определена функция, где используется переменная, где упоминается строка/паттерн. НЕ используй \`run\` с findstr — grep быстрее, безопаснее и форматирует результат.

═══ GIT и GITHUB ═══

${githubBlock}

ТИПИЧНЫЕ СЦЕНАРИИ:

«закоммить изменения» / «commit» — выполни через run:
<tool name="run"><command>git add . && git commit -m "сообщение коммита"</command></tool>

«запушить» / «push» — выполни:
<tool name="run"><command>git push</command></tool>

«закоммить и запушить» — одной командой:
<tool name="run"><command>git add . && git commit -m "сообщение" && git push</command></tool>

═══ SHELL ═══

<tool name="run"> запускает команду в cmd.exe на Windows (UTF-8). Используй cmd-синтаксис:
- \`dir /b\` (НЕ \`Get-ChildItem -Name\`), \`cd /d D:\\path\`, \`gradlew.bat runClient\`, \`type file.txt\`.
- Условные цепочки: \`a && b\` (b только если a успешна) или \`a & b\` (b всегда).
- Рабочая папка между вызовами СОХРАНЯЕТСЯ. Достаточно одного \`<tool name="run"><command>cd /d D:\\path</command></tool>\`, дальше все команды идут из этой папки.
- Если запускаешь \`.bat\` / \`.cmd\` — пиши имя как есть (\`gradlew.bat\`), без \`./\` префикса.
- \`start "Title" cmd /k "..."\` — нормальный способ открыть отдельное cmd-окно для долгого процесса. Перед \`start\` обязательно убедись через \`dir\`/\`cd\` что путь существует — иначе новое окно будет беспечно бипать.

ВАЖНО — поведение \`run\` для **долгих процессов** (dev-сервер, watcher, и т.п.):
- Когда выполняешь \`npm run dev\` / \`pnpm dev\` / \`yarn dev\` / \`node server.js\` — этот \`run\` НЕ ждёт завершения процесса навечно.
- Как только в выводе появится маркер готовности (\`ready in\`, \`local: http://\`, \`compiled successfully\`, \`http://localhost\` и т.п.) — system автоматом резолвит tool и присылает тебе снимок вывода с \`status: процесс запущен и продолжает работать в фоне\`.
- В этот момент сервер ПРОДОЛЖАЕТ работать. НЕ надо запускать его повторно «потому что он не дождался». НЕ надо его «останавливать» — пользователь сам остановит когда захочет.
- Просто отчитайся: «Сервер поднялся на http://localhost:PORT, можно открыть в браузере».
- Если в \`status:\` написано "не выдаёт вывод 6s" — значит команда висит без вывода (intencionalно или REPL), тоже продолжает крутиться.

«создать репозиторий» / «init» — если папка не git:
<tool name="run"><command>git init && git add . && git commit -m "Initial commit"</command></tool>
Потом пользователь сам делает remote add или ты используешь gh repo create если есть gh.

«статус» — git status:
<tool name="run"><command>git status</command></tool>

ВАЖНО:
- Сообщение коммита формулируй кратко и по существу: что именно сделал ("fix login bug", "add settings panel" и т.п.). Не пиши плейсхолдеры.
- Если не знаешь что менялось — сначала \`git status\` или \`git diff --stat\` чтобы понять.
- После \`git push\` всегда показывай пользователю output чтобы он видел успех/ошибки.

Текущая открытая папка: ${cwd || '(не открыта)'}`;
};

const BLOCKED_PATHS = ['\\elproject\\src\\renderer.js', '\\elproject\\main.js', '\\elproject\\preload.js', '\\elproject\\src\\styles.css', '\\elproject\\src\\index.html'];

function isBlockedPath(p) {
  if (!p) return false;
  const lower = p.toLowerCase().replace(/\//g, '\\');
  return BLOCKED_PATHS.some(b => lower.endsWith(b));
}

function parseToolCall(text) {
  // Очищаем markdown-обёртки если модель обернула tool в ```xml ... ```
  let t = text.replace(/```(?:xml|tool)?\s*\n?([\s\S]*?)\n?```/gi, '$1');
  let m = t.match(/<tool\s+name\s*=\s*["']?(\w+)["']?\s*>([\s\S]*?)<\/tool\s*>/i);
  if (!m) {
    // Незакрытый tool в конце ответа — выдёргиваем что можно.
    m = t.match(/<tool\s+name\s*=\s*["']?(\w+)["']?\s*>([\s\S]*)$/i);
    if (!m) return null;
  }
  const name = m[1].toLowerCase();
  const args = {};
  const re = /<(\w+)\s*>([\s\S]*?)<\/\1\s*>/g;
  let a;
  while ((a = re.exec(m[2])) !== null) args[a[1]] = a[2];
  if (args.path) args.path = args.path.trim();
  return { name, args };
}

function renderToolBlock(parentBody, call) {
  const block = document.createElement('div');
  block.className = 'tool-block ' + call.name;
  const path = call.args.path || '';
  const label = ({
    read_file: 'Чтение', write_file: 'Запись', delete: 'Удаление',
    list_dir: 'Список', mkdir: 'Папка', run: 'Команда', remember: 'Память'
  })[call.name] || call.name;
  block.innerHTML = '<div class="tb-head">'
    + '<span class="tb-icon"></span>'
    + '<span class="tb-fname"></span>'
    + '<span class="tb-stats"></span>'
    + '<span class="tb-action">' + label + '</span>'
    + '<span class="status run">…</span>'
    + '</div>'
    + '<div class="tb-skip" title="Прервать агента">Skip</div>'
    + '<div class="tb-body" style="display:none"></div>';
  // Для run/remember показываем команду/заметку вместо имени файла.
  let headIcon = getFileBadge(path.split(/[\\/]/).pop() || '');
  let headName = path.split(/[\\/]/).pop() || call.name;
  let headTitle = path;
  if (call.name === 'run') {
    const cmd = (call.args.command || '').trim();
    headIcon = '$';
    headName = cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd;
    headTitle = cmd;
  } else if (call.name === 'remember') {
    headIcon = '★';
    const note = (call.args.note || '').trim();
    headName = note.length > 60 ? note.slice(0, 60) + '…' : note;
    headTitle = note;
  } else if (call.name === 'grep') {
    headIcon = '⌕';
    const pat = (call.args.pattern || '').trim();
    const glob = (call.args.glob || '').trim();
    const label = glob ? pat + '  in  ' + glob : pat;
    headName = label.length > 60 ? label.slice(0, 60) + '…' : label;
    headTitle = label;
  }
  block.querySelector('.tb-icon').textContent = headIcon;
  block.querySelector('.tb-fname').textContent = headName;
  block.querySelector('.tb-fname').title = headTitle;
  block.querySelector('.tb-head').addEventListener('click', () => {
    const body = block.querySelector('.tb-body');
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  });
  block.querySelector('.tb-skip')?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Скипаем только текущий tool — агент продолжит со следующим шагом.
    if (typeof state.currentSkipResolve === 'function') {
      state.currentSkipResolve('skipped');
    }
  });
  parentBody.appendChild(block);
  scrollIfPinned();
  return block;
}

function renderDiffHtml(oldText, newText, contextLines = 2) {
  const a = (oldText || '').split(/\r?\n/);
  const b = (newText || '').split(/\r?\n/);
  // Простой O(n*m) LCS на коротких файлах
  const lcs = [];
  for (let i = 0; i <= a.length; i++) lcs.push(new Int16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ t: 'eq', s: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: 'del', s: a[i] }); i++; }
    else { ops.push({ t: 'add', s: b[j] }); j++; }
  }
  while (i < a.length) ops.push({ t: 'del', s: a[i++] });
  while (j < b.length) ops.push({ t: 'add', s: b[j++] });

  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t !== 'eq') {
      for (let p = Math.max(0, k - contextLines); p <= Math.min(ops.length - 1, k + contextLines); p++) keep[p] = true;
    }
  }
  let html = '<div class="tb-diff">';
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) continue;
    const cls = ops[k].t === 'add' ? 'add' : ops[k].t === 'del' ? 'del' : 'ctx';
    html += '<div class="dl ' + cls + '">' + escapeHtml(ops[k].s || ' ') + '</div>';
  }
  html += '</div>';
  return { html, add: ops.filter(o => o.t === 'add').length, del: ops.filter(o => o.t === 'del').length };
}

function updateToolBlock(block, call, result) {
  const status = block.querySelector('.status');
  const skipped = !!result.skipped;
  const ok = !result.error && !skipped;
  status.className = 'status ' + (skipped ? 'skip' : ok ? 'ok' : 'err');
  status.textContent = skipped ? 'skip' : ok ? 'ok' : 'fail';
  // Завершилось — убираем Skip-надпись.
  const skip = block.querySelector('.tb-skip');
  if (skip) skip.remove();
  const body = block.querySelector('.tb-body');
  const stats = block.querySelector('.tb-stats');

  if (ok && (call.name === 'write_file' || call.name === 'edit_file')) {
    const oldT = result.oldContent == null ? '' : String(result.oldContent);
    const newT = result.newContent == null
      ? (call.args.content == null ? '' : String(call.args.content))
      : String(result.newContent);
    const d = renderDiffHtml(oldT, newT);
    stats.innerHTML = '<span class="add">+' + d.add + '</span><span class="del">−' + d.del + '</span>';
    body.innerHTML = d.html;
    body.style.display = 'block';
  } else if (ok && call.name === 'read_file') {
    const pre = document.createElement('pre');
    pre.className = 'tb-result';
    pre.textContent = (result.text || '').slice(0, 8000);
    body.innerHTML = '';
    body.appendChild(pre);
  } else if (call.name === 'run' && body.querySelector('.tb-live')) {
    // У run-команды уже есть live-pre с накопленным выводом — НЕ затираем.
    // Просто добавляем хвостом строку с exit code / cwd (если её там нет) и снимаем .tb-live (мигающий курсор).
    const live = body.querySelector('.tb-live');
    const finalLine = (result.text || '').split('\n').filter(l => /^(exit code:|cwd:|error:|\[пропущено)/.test(l)).join('\n');
    if (finalLine && !live.textContent.includes(finalLine)) {
      live.textContent += '\n' + finalLine;
    }
    live.classList.remove('tb-live');
    body.style.display = 'block';
  } else {
    const pre = document.createElement('pre');
    pre.className = 'tb-result';
    pre.textContent = result.text || '';
    body.innerHTML = '';
    body.appendChild(pre);
    if (!ok || (result.text && result.text.length > 0)) body.style.display = 'block';
  }
  scrollIfPinned();
}

async function executeTool(call) {
  const { name, args } = call;
  try {
    if (name === 'read_file') {
      if (!args.path) return { error: true, text: 'path required' };
      const r = await window.app.read(args.path);
      if (r?.error) return { error: true, text: r.error };
      return { text: r.content || '' };
    }
    if (name === 'write_file') {
      if (!args.path) return { error: true, text: 'path required' };
      if (isBlockedPath(args.path)) return { error: true, text: 'Запись в файлы редактора заблокирована: ' + args.path };
      const content = args.content == null ? '' : String(args.content);
      const exists = await window.app.exists(args.path);
      let oldContent = null;
      if (exists) {
        const prev = await window.app.read(args.path);
        if (!prev?.error) oldContent = prev.content || '';
      }
      const r = await window.app.writeAuto(args.path, content);
      if (r?.error) return { error: true, text: r.error };
      trackAgentChange(exists ? 'write' : 'create', args.path, exists ? oldContent : null, content);
      return { text: 'OK, ' + content.length + ' символов записано', oldContent: exists ? oldContent : '', newContent: content };
    }
    if (name === 'edit_file') {
      if (!args.path) return { error: true, text: 'path required' };
      if (args.old_string == null) return { error: true, text: 'old_string required' };
      if (args.new_string == null) return { error: true, text: 'new_string required' };
      if (isBlockedPath(args.path)) return { error: true, text: 'Правка файлов редактора заблокирована: ' + args.path };
      const prev = await window.app.read(args.path);
      if (prev?.error) return { error: true, text: 'Не могу прочитать ' + args.path + ': ' + prev.error + ' (для создания файла используй write_file)' };
      const oldContent = prev.content == null ? '' : String(prev.content);
      const oldStr = String(args.old_string);
      const newStr = String(args.new_string);
      const replaceAll = args.replace_all === 'true' || args.replace_all === true || args.replace_all === '1';
      if (!oldStr.length) return { error: true, text: 'old_string не может быть пустым' };
      let count = 0;
      let idx = 0;
      while (idx <= oldContent.length) {
        const found = oldContent.indexOf(oldStr, idx);
        if (found === -1) break;
        count++;
        idx = found + oldStr.length;
        if (count > 50) break;
      }
      if (count === 0) {
        return { error: true, text: 'old_string не найден в ' + args.path + '. Прочитай файл через read_file и скопируй точный фрагмент (включая пробелы и переносы строк).' };
      }
      if (count > 1 && !replaceAll) {
        return { error: true, text: 'old_string встречается ' + count + ' раз в ' + args.path + '. Добавь больше контекста (строки выше/ниже) чтобы фрагмент стал уникален, или передай <replace_all>true</replace_all>.' };
      }
      const newContent = replaceAll ? oldContent.split(oldStr).join(newStr) : oldContent.replace(oldStr, newStr);
      if (newContent === oldContent) {
        return { error: true, text: 'Замена не изменила файл (new_string совпадает с old_string?).' };
      }
      const r = await window.app.writeAuto(args.path, newContent);
      if (r?.error) return { error: true, text: r.error };
      trackAgentChange('write', args.path, oldContent, newContent);
      const replaced = replaceAll ? count : 1;
      return { text: 'OK, заменено ' + replaced + ' вхождений в ' + args.path, oldContent, newContent };
    }
    if (name === 'grep') {
      const pattern = (args.pattern || '').trim();
      if (!pattern) return { error: true, text: 'pattern required' };
      const root = ((args.path || '').trim()) || state.rootDir;
      if (!root) return { error: true, text: 'Не задан <path> и нет открытой папки в редакторе' };
      const ci = args.case_insensitive === 'true' || args.case_insensitive === true || args.case_insensitive === '1';
      let re;
      try { re = new RegExp(pattern, ci ? 'i' : ''); }
      catch (e) { return { error: true, text: 'Невалидный regex: ' + (e?.message || e) }; }
      const glob = (args.glob || '').trim();
      let globRe = null;
      if (glob) {
        const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        globRe = new RegExp('^' + escaped + '$', 'i');
      }
      let files;
      try { files = await window.app.listAll(root); }
      catch (e) { return { error: true, text: 'Не удалось перечислить файлы в ' + root + ': ' + (e?.message || e) }; }
      if (!Array.isArray(files)) return { error: true, text: 'listAll вернул не массив (открыта ли папка?)' };
      const MAX_FILES = 500;
      const MAX_MATCHES = 100;
      const MAX_LINE_LEN = 300;
      const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|svg|pdf|zip|gz|tar|7z|rar|exe|dll|so|dylib|class|jar|bin|lock|woff2?|ttf|otf|eot|mp[34]|wav|ogg|mov|mp4|webm|wasm|node)$/i;
      const matches = [];
      let scanned = 0;
      let skippedSize = 0;
      const sep = (root.endsWith('\\') || root.endsWith('/')) ? '' : '\\';
      for (const rel of files) {
        if (scanned >= MAX_FILES) break;
        if (matches.length >= MAX_MATCHES) break;
        const base = rel.split(/[\\/]/).pop();
        if (SKIP_EXT.test(base)) continue;
        if (globRe && !globRe.test(base)) continue;
        scanned++;
        const full = root + sep + rel;
        let r;
        try { r = await window.app.read(full); } catch (_) { continue; }
        if (!r || r.error) { if (r && r.error && /too large/i.test(r.error)) skippedSize++; continue; }
        const content = r.content || '';
        if (!content) continue;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            let ln = lines[i];
            if (ln.length > MAX_LINE_LEN) ln = ln.slice(0, MAX_LINE_LEN) + '…';
            matches.push(rel + ':' + (i + 1) + ': ' + ln);
            if (matches.length >= MAX_MATCHES) break;
          }
        }
      }
      if (!matches.length) {
        return { text: 'Совпадений нет. Просканировано файлов: ' + scanned + (skippedSize ? ' (пропущено крупных: ' + skippedSize + ')' : '') };
      }
      const head = 'Найдено ' + matches.length + (matches.length >= MAX_MATCHES ? '+ (лимит)' : '') + ' совпадений в ' + scanned + ' файлах' + (skippedSize ? ' (пропущено крупных: ' + skippedSize + ')' : '') + ':\n';
      return { text: head + matches.join('\n') };
    }
    if (name === 'delete') {
      if (!args.path) return { error: true, text: 'path required' };
      if (isBlockedPath(args.path)) return { error: true, text: 'Удаление файлов редактора заблокировано' };
      let oldContent = null;
      const prev = await window.app.read(args.path);
      if (!prev?.error) oldContent = prev.content;
      const r = await window.app.rm(args.path);
      if (r?.error) return { error: true, text: r.error };
      trackAgentChange('delete', args.path, oldContent, null);
      return { text: 'OK, удалено' };
    }
    if (name === 'list_dir') {
      if (!args.path) return { error: true, text: 'path required' };
      const r = await window.app.tree(args.path, { showHidden: false });
      if (!r) return { error: true, text: 'не могу прочитать' };
      const entries = (r.children || []).map(c => (c.type === 'dir' ? '[DIR] ' : '      ') + c.name).join('\n');
      return { text: entries || '(пусто)' };
    }
    if (name === 'mkdir') {
      if (!args.path) return { error: true, text: 'path required' };
      const r = await window.app.mkdir(args.path);
      if (r?.error) return { error: true, text: r.error };
      return { text: 'OK, папка создана' };
    }
    if (name === 'remember') {
      const note = (args.note || '').trim();
      if (!note) return { error: true, text: 'note required' };
      try {
        state.memory = await window.app.memory.add(note);
        return { text: 'Запомнил: ' + note + ' (всего заметок: ' + state.memory.length + ')' };
      } catch (e) {
        return { error: true, text: 'Не удалось сохранить: ' + (e?.message || e) };
      }
    }
    if (name === 'run') {
      const command = (args.command || '').trim();
      if (!command) return { error: true, text: 'command required' };

      // Чистый `cd PATH` / `cd /d PATH` — обрабатываем сами без спавна,
      // чтобы рабочая папка сохранялась между вызовами агента.
      const pureCd = command.match(/^\s*cd(?:\s+\/d)?\s+(?:"([^"]+)"|(\S.*?))\s*$/i);
      if (pureCd && !/[&|;]/.test(command)) {
        const target = (pureCd[1] || pureCd[2] || '').trim();
        const base = state.agentCwd || state.rootDir || '';
        const resolved = await window.app.run({
          command: 'cd /d "' + target.replace(/"/g, '') + '" & cd',
          cwd: base || undefined,
          timeout: 5000,
          shellExec: true,
          shell: 'cmd'
        });
        if (resolved?.code === 0 && resolved.stdout) {
          const newCwd = resolved.stdout.trim().split(/\r?\n/).pop().trim();
          if (newCwd) state.agentCwd = newCwd;
          return { text: 'Текущая папка: ' + (state.agentCwd || '?') };
        }
        return { error: true, text: 'Не удалось сменить папку на: ' + target + '\n' + (resolved?.stderr || '') };
      }

      // Обычная команда — выполняем через стрим, чтобы юзер видел вывод вживую.
      const base = state.agentCwd || state.rootDir || '';
      const MARKER = '__ELPROJECT_CWD__';
      const wrapped = '(' + command + ') & echo ' + MARKER + '& cd';
      const sid = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      // Поведение паттерна готовности dev-сервера — резолвим промис, но процесс НЕ убиваем.
      // Это нужно, чтобы агент получил снимок вывода и пошёл дальше, а сервер продолжил крутиться.
      const READY_RE = /ready in |listening on|local:\s+http|running at\s+http|started server|webpack compiled|compiled successfully|server (?:is )?running|http:\/\/localhost/i;
      // Если за N мс не было вывода — считаем, что команда «остановилась» (для интерактивных типа node REPL).
      const IDLE_MS = 6000;

      const job = { stdout: '', stderr: '', block: state.currentToolBlock, livePre: null, resolved: false };
      const appendLive = (chunk) => {
        if (!job.block) return;
        const bodyEl = job.block.querySelector('.tb-body');
        if (!job.livePre) {
          job.livePre = document.createElement('pre');
          job.livePre.className = 'tb-result tb-live';
          bodyEl.innerHTML = '';
          bodyEl.appendChild(job.livePre);
          bodyEl.style.display = 'block';
        }
        job.livePre.textContent += chunk;
        if (job.livePre.textContent.length > 200000) {
          job.livePre.textContent = '…(старый вывод обрезан)\n' + job.livePre.textContent.slice(-150000);
        }
      };
      // Skip → killStream + резолвим как «killed».
      state.currentRunKill = () => { try { window.app.killStream(sid); } catch (_) {} };

      const result = await new Promise((resolve) => {
        let idleTimer = null;
        let offData, offExit;
        const detach = () => { try { offData?.(); } catch (_) {} try { offExit?.(); } catch (_) {} };
        const finish = (reason, code) => {
          if (job.resolved) return;
          job.resolved = true;
          if (idleTimer) clearTimeout(idleTimer);
          if (reason === 'exit' || reason === 'killed') {
            // Процесс действительно завершился — отписываемся, чистим UI-курсор.
            detach();
            if (job.livePre) job.livePre.classList.remove('tb-live');
            state.currentRunKill = null;
          } else {
            // Процесс продолжает работать — listener'ы оставляем, чтобы новые чанки
            // дальше дописывались в блок (агент уже перешёл к следующему шагу).
          }
          resolve({ code: code ?? 0, reason });
        };
        offData = window.app.onRunStreamData(({ id, kind, text }) => {
          if (id !== sid || !text) return;
          if (kind === 'stderr') job.stderr += text;
          else job.stdout += text;
          appendLive(text);
          // Idle-таймер сбрасываем на каждый чанк.
          if (idleTimer) clearTimeout(idleTimer);
          if (!job.resolved) idleTimer = setTimeout(() => finish('idle'), IDLE_MS);
          // Если матч паттерна готовности — даём 600мс чтобы прилетели ещё пара строк, потом резолвим.
          if (!job.resolved && READY_RE.test(job.stdout) || READY_RE.test(job.stderr)) {
            setTimeout(() => finish('ready'), 600);
          }
        });
        offExit = window.app.onRunStreamExit(({ id, code, error }) => {
          if (id !== sid) return;
          finish('exit', code);
        });
        window.app.runStream(sid, { command: wrapped, cwd: base || undefined });
        // На случай моментального отсутствия вывода — стартуем idle-таймер сразу.
        idleTimer = setTimeout(() => finish('idle'), IDLE_MS);
      });

      // Вырезаем маркер и обновляем agentCwd (если он встретился в выводе).
      let stdout = job.stdout, stderr = job.stderr;
      const idx = stdout.lastIndexOf(MARKER);
      if (idx >= 0) {
        const tail = stdout.slice(idx + MARKER.length).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (tail.length) state.agentCwd = tail[tail.length - 1];
        stdout = stdout.slice(0, idx).replace(/[\r\n]+$/, '');
      }
      const parts = [];
      if (stdout) parts.push('STDOUT:\n' + stdout);
      if (stderr) parts.push('STDERR:\n' + stderr);
      parts.push('cwd: ' + (state.agentCwd || base || '?'));
      if (result.reason === 'ready') {
        parts.push('status: процесс запущен и продолжает работать в фоне (детектирован паттерн готовности).');
      } else if (result.reason === 'idle') {
        parts.push('status: процесс не выдаёт вывод ' + (IDLE_MS / 1000) + 's, продолжает работать в фоне (если был долгим).');
      } else {
        parts.push('exit code: ' + (result.code == null ? '?' : result.code));
      }
      const text = parts.join('\n');
      const exited = result.reason === 'exit';
      const ok = !exited || result.code === 0;
      return ok ? { text } : { error: true, text };
    }
    return { error: true, text: 'Неизвестный tool: ' + name };
  } catch (e) {
    return { error: true, text: String(e?.message || e) };
  }
}

async function runAgentLoop(providerId, key, model) {
  state.agentBusy = true;
  if (!state.agentCwd) state.agentCwd = state.rootDir || null;
  // Подгружаем актуальное состояние GitHub — есть ли credential helper / только username / ничего.
  let gh = { connected: false, username: '', hasToken: false };
  try {
    const a = await window.app.git.checkAuth();
    if (a?.connected) {
      gh.connected = true;
      gh.username = a.username || '';
      gh.hasToken = !!a.hasToken;
    }
  } catch (_) {}
  const systemMsg = { role: 'system', content: AGENT_SYSTEM(state.agentCwd || state.rootDir, gh) };
  const maxIter = 20;
  try {
    for (let iter = 0; iter < maxIter; iter++) {
      if (state.agentStopped) break;
      const msgs = [systemMsg, ...buildMessagesForApi()];
      const sid = makeStreamId();
      state.currentStreamId = sid;
      state.streamHandledLocally = true;
      setAgentStatus(iter === 0 ? 'Думаю' : 'Анализирую результат');
      const replyEl = pushMessage('assistant', '');
      const body = replyEl.querySelector('.body');
      let buf = '';

      let aborted = false;
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => { try { offC(); offD(); offE(); } catch (_) {} state.streamHandledLocally = false; state.currentStreamId = null; };
        const offC = window.app.onChunk(({ id, text }) => {
          if (id !== sid || settled) return;
          buf += text;
          // Прячем XML в стриме, показываем только текст вокруг.
          const stripped = buf.replace(/<tool[\s\S]*?(<\/tool\s*>|$)/gi, '').trim();
          body.textContent = stripped || '…';
          scrollIfPinned();
        });
        const offD = window.app.onDone(({ id }) => {
          if (id !== sid || settled) return;
          settled = true; cleanup(); resolve(buf);
        });
        const offE = window.app.onError(({ id, error }) => {
          if (id !== sid || settled) return;
          settled = true; cleanup();
          // Если ошибка — следствие нажатия Stop, не падаем а возвращаем что собрали.
          if (state.agentStopped) { aborted = true; resolve(buf); return; }
          reject(new Error(error));
        });
        window.app.chat({
          id: sid, providerId, key, model, messages: msgs,
          extras: state.settings?.extras?.[providerId] || {},
          webSearch: !!state.webSearch && providerSupportsWebSearch(providerId)
        }).catch(reject);
      });

      state.messages[state.messages.length - 1].content = result;
      if (state.agentStopped) {
        const clean = result.replace(/<tool[\s\S]*?<\/tool\s*>/gi, '').trim();
        body.innerHTML = renderMarkdown(clean || '⏹ Остановлено');
        hookupMarkdown(body);
        break;
      }
      const call = parseToolCall(result);
      if (!call) {
        const clean = result.replace(/<tool[\s\S]*?<\/tool\s*>/gi, '').trim();
        body.innerHTML = renderMarkdown(clean);
        hookupMarkdown(body);
        setAgentStatus('');
        break;
      }
      // Показываем что именно делает агент.
      const label = TOOL_STATUS_LABEL[call.name] || call.name;
      const fname = call.args.path ? call.args.path.split(/[\\/]/).pop() : '';
      setAgentStatus(fname ? `${label}: ${fname}` : label);

      // Текст до tool — рендерим как markdown, потом appendим tool-блок.
      const preToolText = (result.split(/<tool\b/i)[0] || '').trim();
      body.innerHTML = preToolText ? renderMarkdown(preToolText) : '';
      hookupMarkdown(body);
      const tblock = renderToolBlock(body, call);
      // Skip-механика: пользователь может прервать ОДНУ команду, агент продолжит работу.
      let skipResolve;
      const skipPromise = new Promise((res) => { skipResolve = res; });
      state.currentSkipResolve = () => {
        // Убиваем выполняющийся процесс (если есть) — тогда runStream резолвит promise
        // с тем, что успело прийти; параллельно дёргаем skipResolve, чтобы пометить как skipped.
        state.toolWasSkipped = true;
        if (typeof state.currentRunKill === 'function') {
          try { state.currentRunKill(); } catch (_) {}
        }
        skipResolve('skipped');
      };
      state.currentToolBlock = tblock;
      state.toolWasSkipped = false;
      // Не используем race с фиксированным «Пропущено пользователем» — пусть executeTool
      // дожмёт остатки stdout/stderr из убитого процесса. Зато пометим skipped по флагу.
      let toolResult;
      try {
        toolResult = await executeTool(call);
        if (state.toolWasSkipped) {
          toolResult = { ...toolResult, skipped: true, text: (toolResult.text || '') + '\n[пропущено пользователем]' };
        }
      } catch (e) {
        toolResult = { error: true, text: String(e?.message || e) };
      }
      state.currentSkipResolve = null;
      state.currentToolBlock = null;
      state.currentRunKill = null;
      updateToolBlock(tblock, call, toolResult);
      if (state.agentStopped) {
        state.messages.push({
          role: 'user',
          content: '<tool_result name="' + call.name + '">' + (toolResult.text || '') + '</tool_result>'
        });
        break;
      }
      state.messages.push({
        role: 'user',
        content: '<tool_result name="' + call.name + '">' + (toolResult.text || '') + '</tool_result>'
      });
    }
  } finally {
    state.agentBusy = false;
    setAgentStatus('');
  }
}

initChatUI();

// ============================================================================
// Контекстное меню для дерева (правый клик) — стиль Cursor.
// ============================================================================

function showTreeContextMenu(x, y, node) {
  const menu = $('ctx-menu');
  if (!menu) return;
  hideCtxMenu();
  const isDir = node.type === 'dir';
  const targetDir = isDir ? node.path : node.path.replace(/[\\/][^\\/]+$/, '');
  const items = [
    { label: 'Новый файл', act: 'new-file', enabled: true },
    { label: 'Новая папка', act: 'new-folder', enabled: true },
    { sep: true },
    { label: 'Показать в Проводнике', shortcut: 'Shift+Alt+R', act: 'reveal', enabled: true },
    { label: 'Открыть в терминале', act: 'open-term', enabled: isDir },
    { sep: true },
    { label: 'Добавить в чат', act: 'add-to-chat', enabled: true },
    { sep: true },
    { label: 'Копировать путь', shortcut: 'Shift+Alt+C', act: 'copy-path', enabled: true },
    { label: 'Копировать относительный путь', act: 'copy-rel', enabled: true },
    { sep: true },
    { label: 'Переименовать', shortcut: 'F2', act: 'rename', enabled: true },
    { label: 'Удалить', shortcut: 'Delete', act: 'delete', enabled: true, danger: true }
  ];
  menu.innerHTML = '';
  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'ctx-item' + (it.enabled ? '' : ' disabled') + (it.danger ? ' danger' : '');
    row.innerHTML = '<span class="ctx-label"></span><span class="ctx-shortcut"></span>';
    row.querySelector('.ctx-label').textContent = it.label;
    if (it.shortcut) row.querySelector('.ctx-shortcut').textContent = it.shortcut;
    if (it.enabled) {
      row.addEventListener('click', () => {
        hideCtxMenu();
        handleCtxAction(it.act, node, targetDir);
      });
    }
    menu.appendChild(row);
  }
  // Position
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('open');
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 8) + 'px';
  });
}

function hideCtxMenu() {
  const m = $('ctx-menu'); if (m) m.classList.remove('open');
}

document.addEventListener('click', hideCtxMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.tree-row')) hideCtxMenu();
});

async function handleCtxAction(act, node, targetDir) {
  if (act === 'reveal') {
    await window.app.showItem(node.path);
  } else if (act === 'open-term') {
    $('terminal-panel')?.classList.add('open');
    await createTerminalInstance('powershell', targetDir);
  } else if (act === 'copy-path') {
    await navigator.clipboard.writeText(node.path).catch(() => {});
    setStatus('Путь скопирован');
  } else if (act === 'copy-rel') {
    const root = state.rootDir || '';
    const rel = root && node.path.startsWith(root) ? node.path.slice(root.length).replace(/^[\\/]/, '') : node.path;
    await navigator.clipboard.writeText(rel).catch(() => {});
    setStatus('Относительный путь скопирован');
  } else if (act === 'add-to-chat') {
    state.contextFiles = state.contextFiles || [];
    if (!state.contextFiles.find(c => c.path === node.path)) {
      state.contextFiles.push({ kind: 'file', path: node.path, name: node.name, rel: node.name });
    }
    renderContextChips();
    setStatus('Добавлен в контекст: ' + node.name);
  } else if (act === 'new-file') {
    const name = await uiPrompt('Имя нового файла:', '');
    if (!name) return;
    const full = (targetDir.endsWith('\\') || targetDir.endsWith('/')) ? targetDir + name : targetDir + '\\' + name;
    const r = await window.app.writeAuto(full, '');
    if (r?.error) { setStatus('Ошибка: ' + r.error); return; }
    await refreshTreeQuiet();
    await openFile(full, name);
  } else if (act === 'new-folder') {
    const name = await uiPrompt('Имя новой папки:', '');
    if (!name) return;
    const full = (targetDir.endsWith('\\') || targetDir.endsWith('/')) ? targetDir + name : targetDir + '\\' + name;
    const r = await window.app.mkdir(full);
    if (r?.error) { setStatus('Ошибка: ' + r.error); return; }
    await refreshTreeQuiet();
  } else if (act === 'rename') {
    const newName = await uiPrompt('Новое имя:', node.name);
    if (!newName || newName === node.name) return;
    const parent = node.path.replace(/[\\/][^\\/]+$/, '');
    const newPath = parent + '\\' + newName;
    const r = await window.app.rename(node.path, newPath);
    if (r?.error) { setStatus('Ошибка: ' + r.error); return; }
    await refreshTreeQuiet();
  } else if (act === 'delete') {
    if (!confirm('Удалить ' + (node.type === 'dir' ? 'папку' : 'файл') + ' "' + node.name + '"?')) return;
    const r = await window.app.rm(node.path);
    if (r?.error) { setStatus('Ошибка: ' + r.error); return; }
    await refreshTreeQuiet();
    setStatus('Удалено: ' + node.name);
  }
}

function uiPrompt(message, defaultValue) {
  return new Promise((resolve) => {
    const modal = $('prompt-modal');
    if (!modal) { resolve(prompt(message, defaultValue)); return; }
    $('prompt-title').textContent = 'Введите имя';
    $('prompt-message').textContent = message;
    const input = $('prompt-input');
    input.value = defaultValue || '';
    modal.classList.add('open');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const close = (val) => {
      modal.classList.remove('open');
      $('prompt-ok').removeEventListener('click', okHandler);
      $('prompt-cancel').removeEventListener('click', cancelHandler);
      $('prompt-cancel-x').removeEventListener('click', cancelHandler);
      input.removeEventListener('keydown', keyHandler);
      resolve(val);
    };
    const okHandler = () => close(input.value);
    const cancelHandler = () => close(null);
    const keyHandler = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); okHandler(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelHandler(); }
    };
    $('prompt-ok').addEventListener('click', okHandler);
    $('prompt-cancel').addEventListener('click', cancelHandler);
    $('prompt-cancel-x').addEventListener('click', cancelHandler);
    input.addEventListener('keydown', keyHandler);
  });
}

// ============================================================================
// Sticky-сообщение: при скролле вверх показываем последнее видимое user-сообщение.
// ============================================================================

function initStickyMessage() {
  const m = $('messages');
  if (!m) return;
  m.addEventListener('scroll', updateStickyMessage);
  // refresh при появлении новых сообщений
  if (typeof MutationObserver === 'function') {
    new MutationObserver(updateStickyMessage).observe(m, { childList: true, subtree: false });
  }
}

function updateStickyMessage() {
  const m = $('messages');
  const sticky = $('sticky-msg');
  if (!m || !sticky) return;
  const userMsgs = m.querySelectorAll('.msg.user .body');
  if (userMsgs.length === 0) { sticky.classList.remove('open'); return; }
  const scrollTop = m.scrollTop;
  let aboveOrAt = null;
  // Найти последнее user-сообщение, верхний край которого выше середины viewport.
  // Когда его НИЖНИЙ край ушёл за верх — закрепляем.
  for (const el of userMsgs) {
    if (el.offsetTop < scrollTop + 8) aboveOrAt = el;
    else break;
  }
  if (!aboveOrAt) { sticky.classList.remove('open'); return; }
  const bottom = aboveOrAt.offsetTop + aboveOrAt.offsetHeight;
  if (bottom > scrollTop + 8) {
    // ещё видно — не закрепляем
    sticky.classList.remove('open');
    return;
  }
  const txt = (aboveOrAt.textContent || '').trim();
  if (!txt) { sticky.classList.remove('open'); return; }
  sticky.textContent = txt.length > 140 ? txt.slice(0, 140) + '…' : txt;
  sticky.classList.add('open');
  sticky.onclick = () => {
    // Прыжок к сообщению — с офсетом на высоту sticky-кнопки + запас,
    // иначе сама кнопка перекрывает верх сообщения.
    const stickyH = sticky.getBoundingClientRect().height || 28;
    const target = Math.max(0, aboveOrAt.offsetTop - stickyH - 8);
    sticky.classList.remove('open');
    m.scrollTo({ top: target, behavior: 'smooth' });
  };
}

// ============================================================================
// Панель агентов (правый sidebar по клику на квадратик в шапке чата).
// ============================================================================

function initAgentsPanel() {
  $('btn-agents-panel')?.addEventListener('click', toggleAgentsPanel);
  $('agents-new')?.addEventListener('click', () => { newChat(); refreshAgentsList(); });
  $('agents-new-cloud')?.addEventListener('click', () => setStatus('Cloud-агенты ещё не подключены'));
  $('agents-search')?.addEventListener('input', refreshAgentsList);
}

function toggleAgentsPanel() {
  const app = document.getElementById('app');
  const panel = $('agents-panel');
  const btn = $('btn-agents-panel');
  if (!app || !panel) return;
  const open = app.classList.toggle('agents-open');
  panel.classList.toggle('open', open);
  if (btn) btn.classList.toggle('active', open);
  // Inline grid-template-columns (от ресайзеров) перебивает CSS-rule, поэтому пересоберём с учётом agents-колонки.
  applyPanelWidths(currentPanelWidth('sidebar'), currentPanelWidth('chat'));
  if (open) refreshAgentsList();
}

function groupChatsByDate(items) {
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  const buckets = { pinned: [], today: [], week: [], month: [], older: [] };
  for (const it of items) {
    if (it.pinned) buckets.pinned.push(it);
    else if (it.updatedAt && now - it.updatedAt < DAY) buckets.today.push(it);
    else if (it.updatedAt && now - it.updatedAt < 7 * DAY) buckets.week.push(it);
    else if (it.updatedAt && now - it.updatedAt < 30 * DAY) buckets.month.push(it);
    else buckets.older.push(it);
  }
  return buckets;
}

async function refreshAgentsList() {
  const list = $('agents-list');
  if (!list) return;
  list.innerHTML = '<div class="agents-loading">Загрузка...</div>';
  let items = [];
  try { items = await window.app.chats.list(); } catch (_) { items = []; }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const q = ($('agents-search')?.value || '').trim().toLowerCase();
  if (q) items = items.filter(it => (it.title || '').toLowerCase().includes(q));
  if (items.length === 0) {
    list.innerHTML = '<div class="agents-empty">Чатов нет</div>';
    return;
  }
  const groups = groupChatsByDate(items);
  list.innerHTML = '';
  const sections = [
    { key: 'pinned', label: 'Pinned' },
    { key: 'today', label: 'Today' },
    { key: 'week', label: 'Last 7 Days' },
    { key: 'month', label: 'Last 30 Days' },
    { key: 'older', label: 'Older' }
  ];
  for (const { key, label } of sections) {
    const arr = groups[key];
    if (!arr.length) continue;
    const h = document.createElement('div');
    h.className = 'agents-section';
    h.textContent = label;
    list.appendChild(h);
    for (const it of arr) list.appendChild(buildAgentRow(it));
  }
}

function buildAgentRow(item) {
  const row = document.createElement('div');
  row.className = 'agents-row' + (item.id === state.chatId ? ' active' : '');
  const title = item.title || 'Без названия';
  row.innerHTML =
    '<svg class="agents-row-icon" width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>' +
    '<span class="agents-row-title"></span>' +
    '<span class="agents-row-meta"></span>';
  row.querySelector('.agents-row-title').textContent = title;
  row.querySelector('.agents-row-meta').textContent = (item.count || 0) + ' msg';
  row.addEventListener('click', async () => {
    await loadChatById(item.id);
    refreshAgentsList();
  });
  row.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    try { await window.app.chats.delete(item.id); } catch (_) {}
    refreshAgentsList();
  });
  return row;
}

// ============================================================================
// Custom titlebar — window controls + menu bar (File/Edit/Selection/View/Go/⋯).
// ============================================================================

function initWindowControls() {
  $('win-min')?.addEventListener('click', () => window.app.window.minimize());
  $('win-max')?.addEventListener('click', () => window.app.window.maximize());
  $('win-close')?.addEventListener('click', () => window.app.window.close());
  window.app.window?.onStateChange?.(({ maximized }) => {
    const btn = $('win-max');
    if (btn) btn.title = maximized ? 'Восстановить' : 'Развернуть';
  });
}

function initTopbarToggles() {
  // Когда панель скрывается, inline gridTemplateColumns (от ресайзеров) перекрыл бы CSS-правила
  // .sidebar-hidden/.chat-hidden — поэтому очищаем inline-стиль и даём правилам отработать.
  // На обратное открытие применяем сохранённые ширины.
  const rebuildLayoutFromClasses = () => {
    const app = document.getElementById('app');
    if (!app) return;
    if (app.classList.contains('sidebar-hidden') || app.classList.contains('chat-hidden')) {
      app.style.gridTemplateColumns = '';
    } else {
      applyPanelWidths(currentSettingsWidth('sidebar'), currentSettingsWidth('chat'));
    }
  };
  $('btn-toggle-sidebar')?.addEventListener('click', () => {
    const app = document.getElementById('app');
    app.classList.toggle('sidebar-hidden');
    $('btn-toggle-sidebar').classList.toggle('active', !app.classList.contains('sidebar-hidden'));
    rebuildLayoutFromClasses();
  });
  // По умолчанию sidebar открыт.
  $('btn-toggle-sidebar')?.classList.add('active');
  $('btn-toggle-chat')?.addEventListener('click', () => {
    const app = document.getElementById('app');
    app.classList.toggle('chat-hidden');
    $('btn-toggle-chat').classList.toggle('active', !app.classList.contains('chat-hidden'));
    rebuildLayoutFromClasses();
  });
  $('btn-toggle-chat')?.classList.add('active');
  $('btn-toggle-terminal-top')?.addEventListener('click', toggleTerminal);
  $('btn-back')?.addEventListener('click', () => history.back());
  $('btn-fwd')?.addEventListener('click', () => history.forward());
}

const MENU_DEFS = {
  file: [
    { label: 'New Text File', shortcut: 'Ctrl+N', act: 'new-file' },
    { sep: true },
    { label: 'Open File...', shortcut: 'Ctrl+O', act: 'open-file' },
    { label: 'Open Folder...', shortcut: 'Ctrl+M Ctrl+O', act: 'open-folder' },
    { label: 'Open Recent', act: 'open-recent', disabled: true },
    { sep: true },
    { label: 'Save', shortcut: 'Ctrl+S', act: 'save' },
    { label: 'Save All', shortcut: 'Ctrl+Alt+S', act: 'save-all' },
    { sep: true },
    { label: 'Close Editor', shortcut: 'Ctrl+F4', act: 'close-editor' },
    { label: 'Close Folder', act: 'close-folder' },
    { sep: true },
    { label: 'Exit', shortcut: 'Alt+F4', act: 'exit' }
  ],
  edit: [
    { label: 'Undo', shortcut: 'Ctrl+Z', act: 'undo' },
    { label: 'Redo', shortcut: 'Ctrl+Y', act: 'redo' },
    { sep: true },
    { label: 'Cut', shortcut: 'Ctrl+X', act: 'cut' },
    { label: 'Copy', shortcut: 'Ctrl+C', act: 'copy' },
    { label: 'Paste', shortcut: 'Ctrl+V', act: 'paste' },
    { sep: true },
    { label: 'Find', shortcut: 'Ctrl+F', act: 'find' },
    { label: 'Replace', shortcut: 'Ctrl+H', act: 'replace' },
    { sep: true },
    { label: 'Find in Files', shortcut: 'Ctrl+Shift+F', act: 'find-in-files' }
  ],
  selection: [
    { label: 'Select All', shortcut: 'Ctrl+A', act: 'select-all' },
    { sep: true },
    { label: 'Copy Line Up', shortcut: 'Shift+Alt+Up', act: 'copy-line-up' },
    { label: 'Copy Line Down', shortcut: 'Shift+Alt+Down', act: 'copy-line-down' },
    { label: 'Move Line Up', shortcut: 'Alt+Up', act: 'move-line-up' },
    { label: 'Move Line Down', shortcut: 'Alt+Down', act: 'move-line-down' },
    { sep: true },
    { label: 'Add Cursor Above', shortcut: 'Ctrl+Alt+Up', act: 'cursor-above' },
    { label: 'Add Cursor Below', shortcut: 'Ctrl+Alt+Down', act: 'cursor-below' }
  ],
  view: [
    { label: 'Command Palette...', shortcut: 'Ctrl+Shift+P', act: 'palette' },
    { sep: true },
    { label: 'Explorer', shortcut: 'Ctrl+Shift+E', act: 'view-explorer' },
    { label: 'Search', shortcut: 'Ctrl+Shift+F', act: 'view-search' },
    { label: 'Source Control', shortcut: 'Ctrl+Shift+G', act: 'view-git' },
    { sep: true },
    { label: 'Terminal', shortcut: 'Ctrl+`', act: 'view-terminal' },
    { sep: true },
    { label: 'Word Wrap', shortcut: 'Alt+Z', act: 'word-wrap' }
  ],
  go: [
    { label: 'Go to File...', shortcut: 'Ctrl+P', act: 'goto-file' },
    { label: 'Go to Line...', shortcut: 'Ctrl+G', act: 'goto-line' },
    { sep: true },
    { label: 'Back', shortcut: 'Alt+Left', act: 'back' },
    { label: 'Forward', shortcut: 'Alt+Right', act: 'fwd' }
  ],
  more: [
    { label: 'Terminal', act: 'view-terminal' },
    { label: 'Settings', shortcut: 'Ctrl+,', act: 'settings' },
    { label: 'About', act: 'about' }
  ]
};

function initMenuBar() {
  const items = document.querySelectorAll('.menu-item');
  items.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuDropdown(btn);
    });
    btn.addEventListener('mouseenter', () => {
      if (document.querySelector('.menu-item.open')) openMenuDropdown(btn);
    });
  });
  document.addEventListener('click', closeMenuDropdown);
}

function openMenuDropdown(btn) {
  const menu = btn.dataset.menu;
  const items = MENU_DEFS[menu] || [];
  const dd = $('menu-dropdown');
  if (!dd) return;
  document.querySelectorAll('.menu-item').forEach(b => b.classList.remove('open'));
  btn.classList.add('open');
  dd.innerHTML = '';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'menu-dropdown-sep'; dd.appendChild(s); continue; }
    const el = document.createElement('div');
    el.className = 'menu-dropdown-item' + (it.disabled ? ' disabled' : '');
    el.innerHTML = '<span class="label"></span><span class="shortcut"></span>';
    el.querySelector('.label').textContent = it.label;
    if (it.shortcut) el.querySelector('.shortcut').textContent = it.shortcut;
    if (!it.disabled) {
      el.addEventListener('click', () => { closeMenuDropdown(); handleMenuAction(it.act); });
    }
    dd.appendChild(el);
  }
  const r = btn.getBoundingClientRect();
  dd.style.left = r.left + 'px';
  dd.style.top = r.bottom + 'px';
  dd.classList.add('open');
}

function closeMenuDropdown() {
  document.querySelectorAll('.menu-item').forEach(b => b.classList.remove('open'));
  $('menu-dropdown')?.classList.remove('open');
}

async function handleMenuAction(act) {
  switch (act) {
    case 'new-file': {
      if (!state.rootDir) { setStatus('Откройте папку'); return; }
      const name = await uiPrompt('Имя нового файла:', '');
      if (!name) return;
      const full = state.rootDir + '\\' + name;
      await window.app.writeAuto(full, '');
      await refreshTreeQuiet();
      await openFile(full, name);
      break;
    }
    case 'open-file': {
      setStatus('Используйте дерево или Ctrl+P для открытия файлов');
      break;
    }
    case 'open-folder': {
      const dir = await window.app.openDir();
      if (dir) await openDir(dir);
      break;
    }
    case 'close-folder':
      state.rootDir = null;
      $('tree').innerHTML = '<div style="padding:8px;color:var(--fg2);font-size:12px">Откройте папку</div>';
      break;
    case 'save': saveCurrent(); break;
    case 'save-all':
      for (const [path, entry] of state.openFiles) {
        if (entry.dirty && entry.model) await window.app.write(path, entry.model.getValue());
      }
      setStatus('Все файлы сохранены');
      break;
    case 'close-editor':
      if (state.activeFile) closeTab(state.activeFile);
      break;
    case 'exit': window.app.window.close(); break;
    case 'undo': state.editor?.trigger('menu', 'undo'); break;
    case 'redo': state.editor?.trigger('menu', 'redo'); break;
    case 'cut': document.execCommand('cut'); break;
    case 'copy': document.execCommand('copy'); break;
    case 'paste': document.execCommand('paste'); break;
    case 'find': state.editor?.trigger('menu', 'actions.find'); break;
    case 'replace': state.editor?.trigger('menu', 'editor.action.startFindReplaceAction'); break;
    case 'select-all': state.editor?.trigger('menu', 'editor.action.selectAll'); break;
    case 'copy-line-up': state.editor?.trigger('menu', 'editor.action.copyLinesUpAction'); break;
    case 'copy-line-down': state.editor?.trigger('menu', 'editor.action.copyLinesDownAction'); break;
    case 'move-line-up': state.editor?.trigger('menu', 'editor.action.moveLinesUpAction'); break;
    case 'move-line-down': state.editor?.trigger('menu', 'editor.action.moveLinesDownAction'); break;
    case 'cursor-above': state.editor?.trigger('menu', 'editor.action.insertCursorAbove'); break;
    case 'cursor-below': state.editor?.trigger('menu', 'editor.action.insertCursorBelow'); break;
    case 'palette': setStatus('Палитра пока не реализована'); break;
    case 'view-explorer': document.querySelector('.ab-btn[data-view="explorer"]')?.click(); break;
    case 'view-search': document.querySelector('.ab-btn[data-view="search"]')?.click(); break;
    case 'view-git': document.querySelector('.ab-btn[data-view="git"]')?.click(); break;
    case 'view-terminal': toggleTerminal(); break;
    case 'word-wrap': state.editor?.updateOptions?.({ wordWrap: state.editor.getOption?.(state.monaco.editor.EditorOption.wordWrap) === 'on' ? 'off' : 'on' }); break;
    case 'goto-file': $('topbar-search-input')?.focus(); break;
    case 'goto-line': state.editor?.trigger('menu', 'editor.action.gotoLine'); break;
    case 'back': history.back(); break;
    case 'fwd': history.forward(); break;
    case 'settings': openSettings(); break;
    case 'about': setStatus('Doomsheek code — AI редактор кода с BYOK для 22 провайдеров'); break;
    default: setStatus('Действие "' + act + '" пока не реализовано');
  }
}

init();