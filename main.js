const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fssync = require('fs');
const { spawn } = require('child_process');
const simpleGit = require('simple-git');
const { checkKey, streamChat } = require('./src/api');
const { PROVIDERS } = require('./src/providers');

// Опциональный node-pty — если установлен, даёт настоящий интерактивный TTY.
// Без него мы fallback'имся на child_process.spawn (работает хуже, особенно для интерактивных команд).
let nodePty = null;
try { nodePty = require('node-pty'); } catch (_) { nodePty = null; }

// Renderer'у нужно знать что pty нет — чтобы включить локальное эхо и line-editing.
const ipcMainInst = require('electron').ipcMain;
ipcMainInst.handle('term:hasPty', () => !!nodePty);

let mainWindow;
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

async function loadSettings() {
  try {
    const buf = await fs.readFile(settingsPath(), 'utf8');
    const data = JSON.parse(buf);
    if (data.keys && safeStorage.isEncryptionAvailable()) {
      for (const [k, v] of Object.entries(data.keys)) {
        if (typeof v === 'string' && v.startsWith('enc:')) {
          try {
            data.keys[k] = safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
          } catch { data.keys[k] = ''; }
        }
      }
    }
    return data;
  } catch {
    return { keys: {}, extras: {}, lastProvider: 'openai', lastModel: 'gpt-4o-mini', lastDir: null, recentDirs: [], showHidden: false };
  }
}

async function saveSettings(data) {
  const out = { ...data, keys: { ...(data.keys || {}) } };
  if (safeStorage.isEncryptionAvailable()) {
    for (const [k, v] of Object.entries(out.keys)) {
      if (typeof v === 'string' && v && !v.startsWith('enc:')) {
        out.keys[k] = 'enc:' + safeStorage.encryptString(v).toString('base64');
      }
    }
  }
  await fs.writeFile(settingsPath(), JSON.stringify(out, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    title: 'Doomsheek code',
    icon: path.join(__dirname, 'logo.png'),
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Включаем <webview> — нужно для встроенного браузера (Google/GitHub login и т.п.).
      webviewTag: true
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', { maximized: false }));
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// Отключаем фоновые сетевые активности Chromium'а — DoH, проверку компонентов,
// safe-browsing, ping'и. Без этого консоль спамит «handshake failed; net_error -100»
// у пользователей без свободного доступа к Google/Chromium-серверам (РФ и т.п.).
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-features', 'NetworkService,NetworkServiceInProcess,DnsOverHttps');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-domain-reliability');
// Понижаем уровень логирования Chromium-стека до FATAL, чтобы не сорить ERROR'ами в консоль.
app.commandLine.appendSwitch('log-level', '3');

// Применить настройку прокси до создания окна (важно: до app.ready).
async function applyProxySettings() {
  try {
    const s = await loadSettings();
    if (s.disableProxy) {
      // Полностью отключаем системный прокси для всех сетевых запросов Electron.
      app.commandLine.appendSwitch('no-proxy-server');
      app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
      // Также чистим env-переменные на всякий случай.
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.http_proxy;
      delete process.env.https_proxy;
      delete process.env.ALL_PROXY;
      delete process.env.all_proxy;
    } else if (s.customProxy) {
      // Используем пользовательский прокси (если задан).
      app.commandLine.appendSwitch('proxy-server', s.customProxy);
    }
  } catch (_) {}
}

app.whenReady().then(async () => {
  await applyProxySettings();
  // Дополнительно — на сессии тоже выставим режим (на случай если switch не сработал).
  try {
    const s = await loadSettings();
    const { session } = require('electron');
    // applySessionProxy конфигурит и default-сессию (наш UI / API) и партицию встроенного браузера.
    const applySessionProxy = async (ses) => {
      if (s.disableProxy) await ses.setProxy({ mode: 'direct' });
      else if (s.customProxy) await ses.setProxy({ proxyRules: s.customProxy });
      else await ses.setProxy({ mode: 'system' });
    };
    await applySessionProxy(session.defaultSession);
    await applySessionProxy(session.fromPartition('persist:inapp-browser'));
  } catch (_) {}
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('settings:get', async () => loadSettings());
ipcMain.handle('settings:set', async (_e, data) => { await saveSettings(data); return true; });
ipcMain.handle('providers:list', () => PROVIDERS);

ipcMain.handle('dialog:openDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (r.canceled || r.filePaths.length === 0) return null;
  return r.filePaths[0];
});

async function readTree(dir, opts = {}, depth = 0, maxDepth = 6) {
  const { showHidden = false } = opts;
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat) return null;
  const name = path.basename(dir) || dir;
  if (!stat.isDirectory()) return { type: 'file', name, path: dir };
  if (depth >= maxDepth) return { type: 'dir', name, path: dir, children: [] };
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { entries = []; }
  const children = [];
  for (const e of entries) {
    if (!showHidden && e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    children.push(e.isDirectory() ? { type: 'dir', name: e.name, path: full, children: null } : { type: 'file', name: e.name, path: full });
  }
  children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { type: 'dir', name, path: dir, children };
}

ipcMain.handle('fs:tree', async (_e, dir, opts) => readTree(dir, opts || {}, 0, 1));
ipcMain.handle('fs:expand', async (_e, dir, opts) => readTree(dir, opts || {}, 0, 1));
ipcMain.handle('fs:home', async () => app.getPath('home'));
ipcMain.handle('fs:drives', async () => {
  if (process.platform !== 'win32') return [];
  const drives = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    try { await fs.access(`${letter}:\\`); drives.push(`${letter}:\\`); } catch {}
  }
  return drives;
});
ipcMain.handle('fs:exists', async (_e, p) => {
  try { await fs.access(p); return true; } catch { return false; }
});
ipcMain.handle('fs:readBin', async (_e, file) => {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 25 * 1024 * 1024) return { error: 'File too large (>25MB)' };
    const buf = await fs.readFile(file);
    return { data: buf.toString('base64'), size: stat.size };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
});
ipcMain.handle('fs:read', async (_e, file) => {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 5 * 1024 * 1024) return { error: 'File too large (>5MB)' };
    const content = await fs.readFile(file, 'utf8');
    return { content };
  } catch (e) { return { error: String(e?.message || e) }; }
});
ipcMain.handle('fs:write', async (_e, file, content) => {
  try { await fs.writeFile(file, content, 'utf8'); return { ok: true }; }
  catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('api:check', async (_e, args) => checkKey(args));

const activeStreams = new Map();
ipcMain.handle('api:chat', async (event, args) => {
  const id = args?.id || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  activeStreams.set(id, controller);
  const send = (ch, data) => { if (!event.sender.isDestroyed()) event.sender.send(ch, { id, ...data }); };
  // Defer one tick so the renderer can register currentStreamId before any chunks/done arrive.
  setImmediate(() => {
    streamChat({
      ...args,
      signal: controller.signal,
      onChunk: (text) => send('api:chunk', { text }),
      onDone: (info) => { activeStreams.delete(id); send('api:done', info || {}); },
      onError: (err) => { activeStreams.delete(id); console.error('[chat error]', err); send('api:error', { error: err }); }
    });
  });
  return id;
});
ipcMain.handle('api:abort', async (_e, id) => {
  const c = activeStreams.get(id);
  if (c) { c.abort(); activeStreams.delete(id); return true; }
  return false;
});

// ===== GitHub auth (Personal Access Token через git credential.helper store) =====
function gitCredsPath() { return path.join(app.getPath('userData'), 'github-creds'); }

ipcMain.handle('git:setAuth', async (_e, { username, token }) => {
  if (!username) return { error: 'username обязателен' };
  try {
    // Если токен указан — записываем полные учётки в credential store (для git push без пароля).
    // Если токен пуст — сохраняем только username как маркер «GitHub подключён» (без push-через-https).
    if (token) {
      const credLine = `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@github.com`;
      await fs.writeFile(gitCredsPath(), credLine + '\n', { mode: 0o600 });
      const credPath = gitCredsPath().replace(/\\/g, '/');
      await new Promise((resolve, reject) => {
        const p = spawn('git', ['config', '--global', 'credential.helper', `store --file=${credPath}`], { windowsHide: true });
        p.on('exit', (code) => code === 0 ? resolve() : reject(new Error('git config failed, код ' + code)));
        p.on('error', reject);
      });
    } else {
      // Без токена — просто маркер: username без credential helper.
      await fs.writeFile(gitCredsPath(), `https://${encodeURIComponent(username)}@github.com\n`, { mode: 0o600 });
    }
    // user.name / user.email — без них git commit падает с «Please tell me who you are».
    const runCfg = (key, val) => new Promise((resolve) => {
      const p = spawn('git', ['config', '--global', key, val], { windowsHide: true });
      p.on('exit', resolve); p.on('error', resolve);
    });
    await runCfg('user.name', username);
    await runCfg('user.email', `${username}@users.noreply.github.com`);
    return { ok: true };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
});

ipcMain.handle('git:checkAuth', async () => {
  // Проверяем — есть ли наш credential файл и в каком он формате.
  // С токеном:    https://user:token@github.com   → hasToken = true
  // Без токена:   https://user@github.com         → hasToken = false (только маркер)
  try {
    const stat = await fs.stat(gitCredsPath());
    if (!stat.isFile()) return { connected: false };
    const content = await fs.readFile(gitCredsPath(), 'utf8');
    const withTok = content.match(/^https?:\/\/([^:@]+):[^@]+@/);
    if (withTok) {
      return { connected: true, username: decodeURIComponent(withTok[1]), hasToken: true };
    }
    const noTok = content.match(/^https?:\/\/([^@:\s]+)@/);
    if (noTok) {
      return { connected: true, username: decodeURIComponent(noTok[1]), hasToken: false };
    }
    return { connected: false };
  } catch { return { connected: false }; }
});

ipcMain.handle('git:logout', async () => {
  try {
    await fs.unlink(gitCredsPath()).catch(() => {});
    return { ok: true };
  } catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('git:status', async (_e, dir) => {
  try {
    const g = simpleGit(dir);
    const isRepo = await g.checkIsRepo();
    if (!isRepo) return { repo: false };
    const status = await g.status();
    const branch = (await g.branch()).current;
    return {
      repo: true,
      branch,
      files: status.files.map(f => ({ path: f.path, index: f.index, working: f.working_dir })),
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      modified: status.modified,
      not_added: status.not_added,
      conflicted: status.conflicted
    };
  } catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('git:diff', async (_e, dir, file, staged) => {
  try {
    const g = simpleGit(dir);
    const args = staged ? ['--cached'] : [];
    if (file) args.push('--', file);
    const out = await g.diff(args);
    return { diff: out };
  } catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('git:stage', async (_e, dir, files) => {
  try {
    console.log('[git:stage]', { dir, files });
    await simpleGit(dir).add(files);
    return { ok: true };
  } catch (e) {
    console.error('[git:stage] FAIL', e);
    return { error: String(e?.message || e) };
  }
});

ipcMain.handle('git:unstage', async (_e, dir, files) => {
  try { await simpleGit(dir).reset(['HEAD', '--', ...files]); return { ok: true }; }
  catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('git:commit', async (_e, dir, message) => {
  const runCfg = (key, val) => new Promise((resolve) => {
    const p = spawn('git', ['config', '--global', key, val], { windowsHide: true });
    p.on('exit', resolve); p.on('error', resolve);
  });
  const ensureIdentity = async () => {
    // Берём username из credential-файла (если есть) и ставим user.name/user.email.
    try {
      const txt = await fs.readFile(gitCredsPath(), 'utf8');
      const m = txt.match(/^https?:\/\/([^:]+):/);
      if (m) {
        const username = decodeURIComponent(m[1]);
        await runCfg('user.name', username);
        await runCfg('user.email', `${username}@users.noreply.github.com`);
        return true;
      }
    } catch (_) {}
    return false;
  };
  const doCommit = async () => simpleGit(dir).commit(message);
  try {
    console.log('[git:commit]', { dir, message });
    const r = await doCommit();
    console.log('[git:commit] OK', r);
    return { ok: true, commit: r.commit };
  } catch (e) {
    const msg = String(e?.message || e);
    console.error('[git:commit] FAIL', msg);
    // Авто-починка отсутствующей identity.
    if (/tell me who you are|user\.email|user\.name/i.test(msg)) {
      const fixed = await ensureIdentity();
      if (fixed) {
        try {
          const r2 = await doCommit();
          console.log('[git:commit] OK after identity fix', r2);
          return { ok: true, commit: r2.commit };
        } catch (e2) {
          console.error('[git:commit] FAIL again', e2);
          return { error: String(e2?.message || e2) };
        }
      }
    }
    return { error: msg };
  }
});

ipcMain.handle('git:push', async (_e, dir) => {
  try { const r = await simpleGit(dir).push(); return { ok: true, output: r }; }
  catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('git:pull', async (_e, dir) => {
  try { const r = await simpleGit(dir).pull(); return { ok: true, output: r }; }
  catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('git:init', async (_e, dir) => {
  try { await simpleGit(dir).init(); return { ok: true }; }
  catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('git:clone', async (event, url, parentDir, name) => {
  try {
    const target = path.join(parentDir, name);
    await fs.mkdir(parentDir, { recursive: true });
    const sender = event.sender;
    const send = (msg) => { if (!sender.isDestroyed()) sender.send('git:clone:progress', { msg }); };
    send(`Клонирование ${url}...`);
    await simpleGit(parentDir).clone(url, name);
    send(`Готово: ${target}`);
    return { ok: true, path: target };
  } catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('git:log', async (_e, dir, limit = 30) => {
  try { const l = await simpleGit(dir).log({ maxCount: limit }); return { commits: l.all }; }
  catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('git:remote', async (_e, dir) => {
  try {
    const r = await simpleGit(dir).getRemotes(true);
    return { remotes: r };
  } catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('git:addRemote', async (_e, dir, name, url) => {
  try { await simpleGit(dir).addRemote(name, url); return { ok: true }; }
  catch (e) { return { error: String(e?.message || e) }; }
});

const terminals = new Map();
function resolveShellProfile(name) {
  const isWin = process.platform === 'win32';
  if (!isWin) {
    return { cmd: process.env.SHELL || '/bin/bash', args: [] };
  }
  // Стартовая команда для PowerShell: переключить вывод/ввод на UTF-8, чтобы кириллица не превращалась в мусор.
  const psInit = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; chcp 65001 > $null; cls";
  switch (name) {
    case 'cmd':
      // /K + chcp 65001 + prompt — UTF-8 + сразу рисуем "D:\path>".
      return { cmd: 'cmd.exe', args: ['/K', 'chcp 65001 > nul && prompt $P$G'] };
    case 'gitbash': {
      const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
      const found = candidates.find((p) => { try { require('fs').accessSync(p); return true; } catch { return false; } });
      // Git Bash сам UTF-8, явно выставим LANG для надёжности.
      return { cmd: found || 'bash.exe', args: ['--login', '-i'] };
    }
    case 'wsl':
      return { cmd: 'wsl.exe', args: [] };
    case 'pwsh':
      return { cmd: 'pwsh.exe', args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', psInit] };
    case 'powershell':
    default:
      return { cmd: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', psInit] };
  }
}
ipcMain.handle('term:create', async (event, cwd, shellName) => {
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const { cmd: shellCmd, args } = resolveShellProfile(shellName);
  const send = (ch, data) => { if (!event.sender.isDestroyed()) event.sender.send(ch, { id, ...data }); };
  // Если переданная папка не существует — fallback на home, чтобы spawn не падал с ENOENT.
  if (cwd) {
    try { fssync.statSync(cwd); } catch { cwd = app.getPath('home'); }
  } else {
    cwd = app.getPath('home');
  }

  // Путь 1: настоящий PTY через node-pty.
  if (nodePty) {
    let ptyProc;
    try {
      ptyProc = nodePty.spawn(shellCmd, args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: cwd || process.cwd(),
        env: process.env
      });
    } catch (e) {
      return { error: `node-pty.spawn(${shellCmd}) упал: ${e.message}` };
    }
    terminals.set(id, { kind: 'pty', proc: ptyProc });
    ptyProc.onData((data) => send('term:data', { data }));
    ptyProc.onExit(({ exitCode }) => { terminals.delete(id); send('term:exit', { code: exitCode }); });
    return id;
  }

  // Путь 2: эмулятор shell — каждая команда отдельный spawn в текущем cwd.
  // Это надёжнее живого shell без TTY: команды (npm, git, dir и т.п.) реально выполняются.
  const startCwd = cwd || process.cwd();
  terminals.set(id, { kind: 'emul', cwd: startCwd, shellName: shellName || 'powershell', activeChild: null });
  setImmediate(() => {
    send('term:data', { data: `PS ${startCwd}> ` });
  });
  return id;
});

// Эмулятор: выполнение одной командной строки.
ipcMain.handle('term:execLine', async (event, id, line) => {
  const entry = terminals.get(id);
  if (!entry || entry.kind !== 'emul') return false;
  const send = (data) => { if (!event.sender.isDestroyed()) event.sender.send('term:data', { id, data }); };
  const trimmed = (line || '').trim();
  const promptStr = () => `PS ${entry.cwd}> `;

  if (!trimmed) { send('\r\n' + promptStr()); return true; }

  // встроенные: cd, cls/clear, exit
  if (/^cd\s/i.test(trimmed) || trimmed === 'cd') {
    const target = trimmed.replace(/^cd\s*/i, '').replace(/^["']|["']$/g, '').trim();
    if (!target || target === '~') { entry.cwd = app.getPath('home'); send('\r\n' + promptStr()); return true; }
    if (target === '..') {
      const parent = path.dirname(entry.cwd);
      entry.cwd = parent;
      send('\r\n' + promptStr());
      return true;
    }
    const resolved = path.isAbsolute(target) ? target : path.join(entry.cwd, target);
    try {
      const st = fssync.statSync(resolved);
      if (!st.isDirectory()) throw new Error('не папка');
      entry.cwd = resolved;
      send('\r\n' + promptStr());
    } catch (e) {
      send(`\r\n\x1b[31mcd: путь не найден: ${target}\x1b[0m\r\n` + promptStr());
    }
    return true;
  }
  if (trimmed === 'cls' || trimmed === 'clear') {
    send('\x1b[2J\x1b[H' + promptStr());
    return true;
  }
  if (trimmed === 'exit') {
    send('\r\n\x1b[33m[терминал закрыт]\x1b[0m\r\n');
    terminals.delete(id);
    send('term:exit', { code: 0 });
    return true;
  }
  if (trimmed === 'pwd' || trimmed === 'cwd') {
    send(`\r\n${entry.cwd}\r\n` + promptStr());
    return true;
  }

  // Запускаем команду через выбранный shell.
  const isWin = process.platform === 'win32';
  let execCmd, execArgs;
  if (entry.shellName === 'cmd') {
    execCmd = 'cmd.exe';
    execArgs = ['/D', '/C', trimmed];
  } else if (entry.shellName === 'gitbash') {
    const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
    execCmd = candidates.find((p) => { try { fssync.accessSync(p); return true; } catch { return false; } }) || 'bash.exe';
    execArgs = ['-c', trimmed];
  } else if (entry.shellName === 'wsl') {
    execCmd = 'wsl.exe';
    execArgs = ['-e', 'bash', '-c', trimmed];
  } else {
    // powershell / pwsh — UTF-8 + Bypass ExecutionPolicy (иначе npm.ps1 и пр. не запустятся).
    execCmd = entry.shellName === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
    const psPrefix = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ";
    execArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psPrefix + trimmed];
  }

  send('\r\n');
  let proc;
  try {
    proc = spawn(execCmd, execArgs, {
      cwd: entry.cwd,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
      windowsHide: true,
      shell: false
    });
  } catch (e) {
    send(`\x1b[31m${e.message}\x1b[0m\r\n` + promptStr());
    return true;
  }
  entry.activeChild = proc;
  proc.stdout.on('data', (d) => send(d.toString('utf8')));
  proc.stderr.on('data', (d) => send(d.toString('utf8')));
  proc.on('exit', (code) => {
    entry.activeChild = null;
    if (code && code !== 0) send(`\r\n\x1b[31m[exit ${code}]\x1b[0m`);
    send('\r\n' + promptStr());
  });
  proc.on('error', (e) => { send(`\x1b[31m${e.message}\x1b[0m\r\n` + promptStr()); entry.activeChild = null; });
  return true;
});
ipcMain.handle('term:write', async (_e, id, data) => {
  const entry = terminals.get(id);
  if (!entry) return false;
  try {
    if (entry.kind === 'pty') entry.proc.write(data);
    else if (entry.kind === 'spawn') entry.proc.stdin.write(data);
    else if (entry.kind === 'emul' && entry.activeChild) {
      // Передача stdin запущенной команде (например python скрипт ждёт ввод).
      try { entry.activeChild.stdin.write(data); } catch {}
    }
    return true;
  } catch { return false; }
});
ipcMain.handle('term:resize', async (_e, id, cols, rows) => {
  const entry = terminals.get(id);
  if (!entry || entry.kind !== 'pty') return false;
  try { entry.proc.resize(cols, rows); return true; } catch { return false; }
});
// Прерывание текущей задачи (Ctrl+C) — убивает запущенную команду, оставляя сам терминал живым.
ipcMain.handle('term:interrupt', async (_e, id) => {
  const entry = terminals.get(id);
  if (!entry) return false;
  if (entry.kind === 'pty') {
    try { entry.proc.write('\x03'); return true; } catch { return false; }
  }
  // Для emul и spawn: убиваем дерево активного дочернего процесса.
  const target = entry.kind === 'emul' ? entry.activeChild : entry.proc;
  if (!target) return false;
  const pid = target.pid;
  if (!pid) return false;
  if (process.platform === 'win32') {
    try { spawn('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }); } catch {}
  } else {
    try { target.kill('SIGINT'); } catch {}
  }
  return true;
});
ipcMain.handle('term:kill', async (_e, id) => {
  const entry = terminals.get(id);
  if (!entry) return false;
  if (entry.kind === 'emul') {
    // Убить активную команду если есть.
    const ac = entry.activeChild;
    if (ac && ac.pid && process.platform === 'win32') {
      try { spawn('taskkill.exe', ['/F', '/T', '/PID', String(ac.pid)], { windowsHide: true }); } catch {}
    } else if (ac) {
      try { ac.kill(); } catch {}
    }
    terminals.delete(id);
    return true;
  }
  const pid = entry.proc?.pid;
  if (process.platform === 'win32' && pid) {
    try { spawn('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }); } catch {}
  }
  try { entry.proc.kill(); } catch {}
  terminals.delete(id);
  return true;
});

async function listFiles(dir, base = dir, results = [], depth = 0, maxDepth = 12, max = 5000) {
  if (results.length >= max || depth >= maxDepth) return results;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return results; }
  const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv', '.turbo', 'out', 'target']);
  for (const e of entries) {
    if (results.length >= max) break;
    if (IGNORE.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.env' && e.name !== '.gitignore') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, base, results, depth + 1, maxDepth, max);
    else if (e.isFile()) results.push(path.relative(base, full));
  }
  return results;
}
ipcMain.handle('fs:listAll', async (_e, dir) => {
  if (!dir) return [];
  return await listFiles(dir, dir, [], 0, 12, 5000);
});

ipcMain.handle('shell:open', async (_e, url) => { shell.openExternal(url); });
ipcMain.handle('shell:showItem', async (_e, p) => { shell.showItemInFolder(p); });
ipcMain.handle('shell:openPath', async (_e, p) => shell.openPath(p));
ipcMain.handle('fs:rename', async (_e, oldPath, newPath) => {
  try { await fs.rename(oldPath, newPath); return { ok: true }; }
  catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('fs:mkdir', async (_e, dir) => {
  try { await fs.mkdir(dir, { recursive: true }); return { ok: true }; }
  catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('fs:rm', async (_e, p) => {
  try { await fs.rm(p, { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('fs:writeBin', async (_e, file, base64) => {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(base64, 'base64'));
    return { ok: true };
  } catch (e) { return { error: String(e?.message || e) }; }
});

ipcMain.handle('fs:writeAuto', async (_e, file, content) => {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    return { ok: true };
  } catch (e) { return { error: String(e?.message || e) }; }
});

// Стриминг shell-команды — отдаём stdout/stderr чанками по мере поступления.
// Используется агентским tool `run`, чтобы:
//  1) пользователь видел вывод в реальном времени;
//  2) при Skip часть вывода всё равно ушла в tool_result.
const streamProcs = new Map();
ipcMain.on('exec:streamStart', (event, args) => {
  const { id, command, cwd } = args || {};
  if (!id || !command) return;
  const send = (ch, data) => { if (!event.sender.isDestroyed()) event.sender.send(ch, { id, ...data }); };
  let proc;
  try {
    const wrapped = 'chcp 65001>nul & ' + command;
    proc = spawn('cmd.exe', ['/d', '/s', '/c', wrapped], { cwd: cwd || process.cwd(), windowsHide: true });
  } catch (e) {
    send('exec:streamExit', { code: -1, error: String(e?.message || e) });
    return;
  }
  streamProcs.set(id, proc);
  // Чистим вывод от BEL и ANSI-escape-кодов цветов/курсора:
  // - BEL (\x07) — Windows-консоль играет на нём «дзинь».
  // - CSI коды (\x1b[...m / \x1b[K / \x1b]...\x07) — у нас вывод идёт через текстовый <pre>
  //   и в tool_result агенту; ESC-символы невидимы, а остатки вида `[32m` сбивают модель.
  const cleanOutput = (s) => s
    .replace(/\x07/g, '')                 // BEL
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI (цвета, движение курсора, очистка строки)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (заголовки окна и т.п.)
    .replace(/\x1b[=>]/g, '');            // одиночные ESC =, ESC > (DEC keypad mode)
  proc.stdout.on('data', (d) => send('exec:streamData', { kind: 'stdout', text: cleanOutput(d.toString('utf8')) }));
  proc.stderr.on('data', (d) => send('exec:streamData', { kind: 'stderr', text: cleanOutput(d.toString('utf8')) }));
  proc.on('error', (e) => { streamProcs.delete(id); send('exec:streamExit', { code: -1, error: String(e?.message || e) }); });
  proc.on('exit', (code) => { streamProcs.delete(id); send('exec:streamExit', { code }); });
});
ipcMain.on('exec:streamKill', (_e, args) => {
  const id = args?.id;
  const proc = streamProcs.get(id);
  if (!proc) return;
  const pid = proc.pid;
  if (process.platform === 'win32' && pid) {
    try { spawn('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }); } catch {}
  } else {
    try { proc.kill(); } catch {}
  }
  streamProcs.delete(id);
});

ipcMain.handle('exec:run', async (_e, opts) => {
  const { command, cwd, timeout = 60000, shellExec = true, shell: shellKind } = opts || {};
  if (!command) return { error: 'empty command' };
  return await new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let proc;
    try {
      if (shellExec) {
        if (isWin) {
          // Для агентского shell (shellKind==='cmd') используем cmd.exe с UTF-8 (chcp 65001),
          // потому что модели обычно пишут cmd-синтаксис (dir /b, gradlew.bat, cd /d) и так читаемая кодировка.
          if (shellKind === 'cmd') {
            const wrapped = 'chcp 65001>nul & ' + command;
            proc = spawn('cmd.exe', ['/d', '/s', '/c', wrapped], { cwd: cwd || process.cwd(), windowsHide: true });
          } else {
            proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], { cwd: cwd || process.cwd(), windowsHide: true });
          }
        } else {
          proc = spawn(process.env.SHELL || '/bin/bash', ['-lc', command], { cwd: cwd || process.cwd() });
        }
      } else {
        const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, '')) || [];
        proc = spawn(parts[0], parts.slice(1), { cwd: cwd || process.cwd(), windowsHide: true });
      }
    } catch (e) { return resolve({ error: String(e?.message || e) }); }
    let stdout = '', stderr = '';
    const t = setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
    // Чистим BEL + ANSI-escape-коды (см. exec:streamStart выше).
    const cleanOutput = (s) => s
      .replace(/\x07/g, '')
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b[=>]/g, '');
    proc.stdout.on('data', (d) => { stdout += cleanOutput(d.toString('utf8')); if (stdout.length > 100000) stdout = stdout.slice(-100000); });
    proc.stderr.on('data', (d) => { stderr += cleanOutput(d.toString('utf8')); if (stderr.length > 100000) stderr = stderr.slice(-100000); });
    proc.on('error', (e) => { clearTimeout(t); resolve({ error: String(e?.message || e), stdout, stderr }); });
    proc.on('exit', (code) => { clearTimeout(t); resolve({ ok: true, code, stdout, stderr }); });
  });
});

// === Поверхностная память между чатами ===
// Хранится в userData/memory.json. Агент сам решает что сохранить через <tool name="remember">.
// Лимит — 20 заметок, чтобы не разрастаться.
const memoryPath = () => path.join(app.getPath('userData'), 'memory.json');
const MEMORY_MAX = 20;

async function loadMemory() {
  try {
    const buf = await fs.readFile(memoryPath(), 'utf8');
    const obj = JSON.parse(buf);
    return Array.isArray(obj?.notes) ? obj.notes : [];
  } catch { return []; }
}
async function saveMemory(notes) {
  const trimmed = (notes || []).slice(-MEMORY_MAX);
  await fs.writeFile(memoryPath(), JSON.stringify({ notes: trimmed }, null, 2));
  return trimmed;
}
ipcMain.handle('memory:get', async () => loadMemory());
ipcMain.handle('memory:add', async (_e, note) => {
  const notes = await loadMemory();
  const text = String(note || '').trim();
  if (!text) return notes;
  // дедупликация — не пишем дубли
  if (notes.some(n => n.text === text)) return notes;
  notes.push({ text, ts: Date.now() });
  return await saveMemory(notes);
});
ipcMain.handle('memory:clear', async () => { await saveMemory([]); return []; });
ipcMain.handle('memory:set', async (_e, notes) => saveMemory(Array.isArray(notes) ? notes : []));

const chatsPath = () => path.join(app.getPath('userData'), 'chats.json');

async function loadChats() {
  try {
    const buf = await fs.readFile(chatsPath(), 'utf8');
    return JSON.parse(buf);
  } catch { return { chats: [] }; }
}
async function saveChatsAll(data) {
  await fs.writeFile(chatsPath(), JSON.stringify(data, null, 2));
}

// Window controls (для кастомного titlebar без системной рамки).
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => !!mainWindow?.isMaximized());
ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });

ipcMain.handle('chats:list', async () => {
  const { chats } = await loadChats();
  return chats.map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages?.length || 0 }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
});
ipcMain.handle('chats:get', async (_e, id) => {
  const { chats } = await loadChats();
  return chats.find(c => c.id === id) || null;
});
ipcMain.handle('chats:save', async (_e, chat) => {
  const data = await loadChats();
  const i = data.chats.findIndex(c => c.id === chat.id);
  if (i >= 0) data.chats[i] = chat;
  else data.chats.push(chat);
  await saveChatsAll(data);
  return true;
});
ipcMain.handle('chats:delete', async (_e, id) => {
  const data = await loadChats();
  data.chats = data.chats.filter(c => c.id !== id);
  await saveChatsAll(data);
  return true;
});
ipcMain.handle('chats:rename', async (_e, id, title) => {
  const data = await loadChats();
  const c = data.chats.find(c => c.id === id);
  if (c) { c.title = title; c.updatedAt = Date.now(); }
  await saveChatsAll(data);
  return true;
});
