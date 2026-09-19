// 画面（renderer）から main へ渡す窓口。
// ★ contextIsolation を切らずに、ここに並べた関数だけを公開します。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('ide', {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
  toolchain: {
    detect: () => invoke('toolchain:detect'),
    pickCompiler: () => invoke('toolchain:pick'),
  },
  dialog: {
    openFolder: () => invoke('dialog:openFolder'),
    confirm: (opts) => invoke('dialog:confirm', opts),
  },
  fs: {
    tree: (dir) => invoke('fs:tree', dir),
    read: (p) => invoke('fs:read', p),
    write: (p, c) => invoke('fs:write', p, c),
    createFile: (dir, name) => invoke('fs:createFile', dir, name),
    createFolder: (dir, name) => invoke('fs:createFolder', dir, name),
    rename: (p, name) => invoke('fs:rename', p, name),
    remove: (p) => invoke('fs:remove', p),
    reveal: (p) => invoke('fs:reveal', p),
  },
  build: {
    check: (src) => invoke('build:check', src),
    compile: (src, opts) => invoke('build:compile', src, opts),
    cancel: () => invoke('build:cancel'),
  },
  run: {
    start: (src) => invoke('run:start', src),
    stdin: (data) => invoke('run:stdin', data),
    stop: () => invoke('run:stop'),
  },
  debug: {
    start: (src, breakpoints) => invoke('debug:start', src, breakpoints),
    resume: () => invoke('debug:cmd', 'continue'),
    stepOver: () => invoke('debug:cmd', 'stepOver'),
    stepInto: () => invoke('debug:cmd', 'stepInto'),
    stepOut: () => invoke('debug:cmd', 'stepOut'),
    pause: () => invoke('debug:cmd', 'pause'),
    stop: () => invoke('debug:stop'),
    addBreakpoint: (file, line) => invoke('debug:addBreakpoint', file, line),
    evaluate: (expr) => invoke('debug:evaluate', expr),
    stdin: (data) => invoke('debug:stdin', data),
  },
  on: (channel, fn) => {
    const allowed = ['app:event'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
