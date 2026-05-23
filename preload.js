const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('app', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (data) => ipcRenderer.invoke('settings:set', data),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  openDir: () => ipcRenderer.invoke('dialog:openDir'),
  tree: (dir, opts) => ipcRenderer.invoke('fs:tree', dir, opts),
  expand: (dir, opts) => ipcRenderer.invoke('fs:expand', dir, opts),
  read: (file) => ipcRenderer.invoke('fs:read', file),
  readBin: (file) => ipcRenderer.invoke('fs:readBin', file),
  write: (file, content) => ipcRenderer.invoke('fs:write', file, content),
  home: () => ipcRenderer.invoke('fs:home'),
  drives: () => ipcRenderer.invoke('fs:drives'),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  checkKey: (args) => ipcRenderer.invoke('api:check', args),
  chat: (args) => ipcRenderer.invoke('api:chat', args),
  abort: (id) => ipcRenderer.invoke('api:abort', id),
  onChunk: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('api:chunk', fn); return () => ipcRenderer.off('api:chunk', fn); },
  onDone: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('api:done', fn); return () => ipcRenderer.off('api:done', fn); },
  onError: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('api:error', fn); return () => ipcRenderer.off('api:error', fn); },

  listAll: (dir) => ipcRenderer.invoke('fs:listAll', dir),

  git: {
    setAuth: (args) => ipcRenderer.invoke('git:setAuth', args),
    checkAuth: () => ipcRenderer.invoke('git:checkAuth'),
    logout: () => ipcRenderer.invoke('git:logout'),
    status: (dir) => ipcRenderer.invoke('git:status', dir),
    diff: (dir, file, staged) => ipcRenderer.invoke('git:diff', dir, file, staged),
    stage: (dir, files) => ipcRenderer.invoke('git:stage', dir, files),
    unstage: (dir, files) => ipcRenderer.invoke('git:unstage', dir, files),
    commit: (dir, msg) => ipcRenderer.invoke('git:commit', dir, msg),
    push: (dir) => ipcRenderer.invoke('git:push', dir),
    pull: (dir) => ipcRenderer.invoke('git:pull', dir),
    init: (dir) => ipcRenderer.invoke('git:init', dir),
    log: (dir, limit) => ipcRenderer.invoke('git:log', dir, limit),
    remotes: (dir) => ipcRenderer.invoke('git:remote', dir),
    addRemote: (dir, name, url) => ipcRenderer.invoke('git:addRemote', dir, name, url),
    clone: (url, parent, name) => ipcRenderer.invoke('git:clone', url, parent, name),
    onCloneProgress: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('git:clone:progress', fn); return () => ipcRenderer.off('git:clone:progress', fn); }
  },

  term: {
    create: (cwd, shell) => ipcRenderer.invoke('term:create', cwd, shell),
    write: (id, data) => ipcRenderer.invoke('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('term:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('term:kill', id),
    execLine: (id, line) => ipcRenderer.invoke('term:execLine', id, line),
    interrupt: (id) => ipcRenderer.invoke('term:interrupt', id),
    hasPty: () => ipcRenderer.invoke('term:hasPty'),
    onData: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('term:data', fn); return () => ipcRenderer.off('term:data', fn); },
    onExit: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('term:exit', fn); return () => ipcRenderer.off('term:exit', fn); }
  },

  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),

  mkdir: (dir) => ipcRenderer.invoke('fs:mkdir', dir),
  rm: (p) => ipcRenderer.invoke('fs:rm', p),
  writeBin: (file, b64) => ipcRenderer.invoke('fs:writeBin', file, b64),
  writeAuto: (file, c) => ipcRenderer.invoke('fs:writeAuto', file, c),
  run: (opts) => ipcRenderer.invoke('exec:run', opts),
  // Стриминг shell-команды — для агентского `run`, чтобы вывод шёл в реальном времени.
  runStream: (id, opts) => ipcRenderer.send('exec:streamStart', { id, ...(opts || {}) }),
  killStream: (id) => ipcRenderer.send('exec:streamKill', { id }),
  onRunStreamData: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('exec:streamData', fn); return () => ipcRenderer.off('exec:streamData', fn); },
  onRunStreamExit: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('exec:streamExit', fn); return () => ipcRenderer.off('exec:streamExit', fn); },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onStateChange: (cb) => { const fn = (_e, p) => cb(p); ipcRenderer.on('window:state', fn); return () => ipcRenderer.off('window:state', fn); }
  },

  chats: {
    list: () => ipcRenderer.invoke('chats:list'),
    get: (id) => ipcRenderer.invoke('chats:get', id),
    save: (chat) => ipcRenderer.invoke('chats:save', chat),
    delete: (id) => ipcRenderer.invoke('chats:delete', id),
    rename: (id, title) => ipcRenderer.invoke('chats:rename', id, title)
  },

  memory: {
    get: () => ipcRenderer.invoke('memory:get'),
    add: (note) => ipcRenderer.invoke('memory:add', note),
    set: (notes) => ipcRenderer.invoke('memory:set', notes),
    clear: () => ipcRenderer.invoke('memory:clear')
  }
});
