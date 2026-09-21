// yashirolang IDE の入口。
// 窓を 1 枚出して、画面からの依頼（IPC）をここで受けます。
'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net } = require('electron');

const settingsStore = require('./settings');
const toolchain = require('./toolchain');
const files = require('./files');
const build = require('./build');
const runner = require('./run');
const { DebugSession } = require('./debug');
const buildMenu = require('./menu');
const sources = require('./sources');
const symbols = require('./symbols');

let win = null;
let session = null;        // いま動いているデバッグ
let openFolder = '';       // 画面で開いているフォルダ（門番の基準）

// IDE 自身のファイルを配る置き場（画面・Monaco）
const APP_ROOT = path.resolve(__dirname, '..', '..');

// 🤔 なぜ file:// で読まずに独自スキームを立てるのか
//   file:// のページは生成元（origin）が null 扱いになり、
//   Monaco が使う Web Worker を作れません。
//   app:// を「普通の安全なスキーム」として登録すると、
//   worker も CSP も、web ページと同じ扱いで動きます。
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// 画面へ出来事を流す。renderer 側は ide.on('app:event', ...) で受けます。
function emit(type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('app:event', { type, payload });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#1e2227',
    title: 'yashirolang IDE',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadURL('app://ide/src/renderer/index.html');
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const target = path.join(APP_ROOT, decodeURIComponent(url.pathname));
    // ★ 配るのはこのリポジトリの中だけ。
    if (!target.startsWith(APP_ROOT + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });

  Menu.setApplicationMenu(buildMenu({
    send: (cmd) => emit('menu', cmd),
    openDevTools: () => win && win.webContents.openDevTools({ mode: 'bottom' }),
  }));
  createWindow();

  // 起動の自己点検（npm run smoke）。ふだんは何もしません。
  if (process.env.YSIDE_SMOKE) require('../../test/smoke')(win, app);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (session) session.stop();
  runner.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (session) session.stop();
  runner.stop();
});

// ── 門番 ───────────────────────────────────────────────
// 画面から来たパスは、開いているフォルダの中かどうかを確かめます。
function guard(p) {
  if (!p) throw new Error('パスが空です');
  if (!openFolder) throw new Error('フォルダを開いてください');
  if (!files.insideRoot(openFolder, p)) throw new Error('開いているフォルダの外は触れません');
  return p;
}

// ── 読むだけなら外も許す場所 ───────────────────────────
//
// 🤔 なぜ緩めるのか
//   `import strings` の中で止まったとき、その行を見せられないと
//   デバッグになりません。標準ライブラリと deps は**書けないまま、
//   読むことだけ**を許します。
//   ⚠️ 書き込み（fs:write / rename / remove）は今までどおり
//     「開いているフォルダの中だけ」です。ここは触りません。
function readableDirs() {
  const st = settingsStore.load();
  const compiler = toolchain.findCompiler(st.compilerPath);
  const out = [];
  if (openFolder) out.push(openFolder);
  if (compiler) {
    const lib = toolchain.libDirOf(compiler);
    if (lib) out.push(lib);
  }
  return out;
}

function guardRead(p) {
  if (!p) throw new Error('パスが空です');
  for (const d of readableDirs()) {
    if (files.insideRoot(d, p)) return { path: p, readonly: !(openFolder && files.insideRoot(openFolder, p)) };
  }
  throw new Error('開いているフォルダと標準ライブラリの外は読めません');
}

// import と定義へ移動が探す場所（処理系と同じ順）
function searchDirsFor(file) {
  const st = settingsStore.load();
  const compiler = toolchain.findCompiler(st.compilerPath);
  return sources.searchDirs({
    entryDir: file ? path.dirname(file) : openFolder,
    root: openFolder,
    libDir: compiler ? toolchain.libDirOf(compiler) : null,
    extraArgs: st.extraArgs,
  });
}

// symbols.js へ渡す「まわりの事情」
const symbolCtx = {
  get settings() { return settingsStore.load(); },
  dirs: (file) => searchDirsFor(file),
};

// 例外をそのまま画面に返す薄い包み
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

// ── 設定 ───────────────────────────────────────────────
handle('settings:get', () => settingsStore.load());
handle('settings:set', (patch) => settingsStore.save(patch));

// ── 道具立て ───────────────────────────────────────────
handle('toolchain:detect', () => toolchain.detect(settingsStore.load()));
handle('toolchain:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'yashirolang コンパイラを選ぶ',
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  settingsStore.save({ compilerPath: r.filePaths[0] });
  return toolchain.detect(settingsStore.load());
});

// ── ダイアログ ─────────────────────────────────────────
handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'フォルダを開く',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  openFolder = r.filePaths[0];
  settingsStore.save({ lastFolder: openFolder });
  return { root: openFolder, items: await files.readDir(openFolder) };
});

handle('dialog:confirm', async ({ message, detail, okLabel }) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [okLabel || 'はい', 'キャンセル'],
    defaultId: 0,
    cancelId: 1,
    message,
    detail,
  });
  return r.response === 0;
});

// ── ファイル ───────────────────────────────────────────
handle('fs:tree', async (dir) => {
  // 起動直後に前回のフォルダを開き直すときは、まだ openFolder が空です。
  if (!openFolder) {
    const last = settingsStore.load().lastFolder;
    if (last && fs.existsSync(last) && (!dir || dir === last)) openFolder = last;
  }
  const target = dir || openFolder;
  if (!target) return null;
  guard(target);
  return { root: openFolder, dir: target, items: await files.readDir(target) };
});

// ★ 読むだけの窓口。標準ライブラリと deps の中も開けます（書けません）。
handle('fs:open', async (p) => {
  const g = guardRead(p);
  return { path: g.path, text: await files.readFile(g.path), readonly: g.readonly };
});

// 標準ライブラリの一覧（左の「ライブラリ」に並べます）
handle('fs:library', async () => {
  const st = settingsStore.load();
  const compiler = toolchain.findCompiler(st.compilerPath);
  const out = [];
  const lib = compiler ? toolchain.libDirOf(compiler) : null;
  if (lib && fs.existsSync(lib)) {
    out.push({ name: '標準ライブラリ', dir: lib, items: await files.readDir(lib) });
  }
  // ysm が置く deps/（package.toml のある木）
  const deps = openFolder ? path.join(openFolder, 'deps') : null;
  if (deps && fs.existsSync(deps)) {
    out.push({ name: 'deps（ysm）', dir: deps, items: await files.readDir(deps) });
  }
  return out;
});

// 入口（`def main()` のあるファイル）を探す。複数ファイルのとき、
// どれを建てればよいかを画面が決めるために使います。
handle('fs:entries', async () => {
  if (!openFolder) return [];
  const map = sources.sourceMap([openFolder], { root: openFolder });
  const out = [];
  for (const list of map.values()) {
    for (const p of list) {
      try {
        if (/^\s*def\s+main\s*\(/m.test(fs.readFileSync(p, 'utf8'))) out.push(p);
      } catch { /* 読めないものは飛ばす */ }
    }
  }
  return out.sort();
});
handle('fs:write', (p, c) => files.writeFile(guard(p), c));
handle('fs:createFile', (dir, name) => files.createFile(guard(dir), name));
handle('fs:createFolder', (dir, name) => files.createFolder(guard(dir), name));
handle('fs:rename', (p, name) => files.rename(guard(p), name));
handle('fs:remove', (p) => files.remove(guard(p), (t) => shell.trashItem(t)));
handle('fs:reveal', (p) => { shell.showItemInFolder(guard(p)); return true; });

// ── 名前（定義へ移動・型の表示）─────────────────────────
//
// ★ 編集中の中身（text）を一緒に受け取ります。保存していなくても
//   いまの中身で答えるためです。
handle('symbols:definition', (file, text, line, character) => {
  guardRead(file);
  return symbols.definition(symbolCtx, { file, text, line, character });
});

handle('symbols:hover', (file, text, line, character) => {
  guardRead(file);
  return symbols.hover(symbolCtx, { file, text, line, character });
});

handle('symbols:outline', (file, text) => {
  guardRead(file);
  return symbols.outline(symbolCtx, { file, text });
});

// ── ビルド ─────────────────────────────────────────────
handle('build:check', async (src) => {
  guard(src);
  emit('console', { stream: 'info', text: `型検査: ${path.basename(src)}\n` });
  const r = await build.check(settingsStore.load(), src, (t) => emit('console', { stream: 'build', text: t }));
  emit('console', { stream: r.ok ? 'ok' : 'err', text: r.ok ? '確認できました。\n' : '確認でエラーが出ました。\n' });
  return r;
});

handle('build:compile', async (src, opts) => {
  guard(src);
  emit('console', { stream: 'info', text: `コンパイル: ${path.basename(src)}\n` });
  const r = await build.compile(settingsStore.load(), src, opts || {}, (t) => emit('console', { stream: 'build', text: t }));
  emit('console', {
    stream: r.ok ? 'ok' : 'err',
    text: r.ok ? `できました: ${r.exe}\n` : 'コンパイルに失敗しました。\n',
  });
  return r;
});

handle('build:cancel', () => build.cancel());

// ── 実行 ───────────────────────────────────────────────
handle('run:start', async (src) => {
  guard(src);
  if (runner.isRunning()) throw new Error('すでに実行中です');
  const r = await build.compile(settingsStore.load(), src, {}, (t) => emit('console', { stream: 'build', text: t }));
  if (!r.ok) {
    emit('console', { stream: 'err', text: 'コンパイルに失敗したので実行しません。\n' });
    return { started: false, ...r };
  }
  emit('console', { stream: 'info', text: `実行: ${path.basename(r.exe)}\n` });
  runner.start(r.exe, path.dirname(src), [], (type, payload) => {
    if (type === 'exit') {
      emit('console', {
        stream: payload.code === 0 ? 'ok' : 'err',
        text: `— 終了コード ${payload.code}${payload.signal ? `（${payload.signal}）` : ''} —\n`,
      });
      emit('run:exit', payload);
    } else {
      emit('console', { stream: type, text: payload });
    }
  });
  return { started: true, ...r };
});

handle('run:stdin', (data) => runner.write(data));
handle('run:stop', () => runner.stop());

// ── デバッグ実行 ───────────────────────────────────────
handle('debug:start', async (src, breakpoints) => {
  guard(src);
  if (session) throw new Error('すでにデバッグ中です');
  if (runner.isRunning()) throw new Error('実行中です。先に停止してください。');

  const st = settingsStore.load();
  const dbg = toolchain.findDebugger(st.debuggerPath);
  if (!dbg) throw new Error('デバッガ（lldb / gdb）が見つかりません。');

  emit('console', { stream: 'info', text: `デバッグ用にコンパイル（-g）: ${path.basename(src)}\n` });
  const r = await build.compile(st, src, { debug: true }, (t) => emit('console', { stream: 'build', text: t }));
  if (!r.ok) {
    emit('console', { stream: 'err', text: 'コンパイルに失敗したのでデバッグを始めません。\n' });
    return { started: false, ...r };
  }

  // ★ 複数ファイルのための地図。
  //   止まった場所が import した先でも標準ライブラリでも、
  //   ここでファイル名から本当の場所を引けるようにしておきます。
  const map = sources.sourceMap(searchDirsFor(src), { root: openFolder });
  const bps = breakpoints || [];
  // ⚠️ デバッガはファイル**名**でしか場所を指せません（DWARF に入って
  //   いるのが名前だけだからです）。同じ名前が 2 か所にあると、
  //   置いたつもりでない方で止まります。黙って進まず、先に言います。
  for (const a of sources.ambiguous(map, bps.map((b) => b.file))) {
    emit('console', {
      stream: 'err',
      text: `⚠️ ${a.name} が ${a.where.length} か所にあります。`
        + 'デバッガはファイル名でしか区別できないので、どちらで止まるか決まりません:\n'
        + a.where.map((w) => '    ' + w).join('\n') + '\n',
    });
  }

  session = new DebugSession(
    { debuggerPath: dbg.path, kind: dbg.kind, exe: r.exe, cwd: path.dirname(src),
      source: src, args: [], sourceMap: map },
    (type, payload) => {
      if (type === 'stdout') emit('console', { stream: 'stdout', text: payload });
      else if (type === 'log') emit('debug:log', payload);
      else if (type === 'exited') {
        emit('console', { stream: 'ok', text: `— デバッグ終了（コード ${payload.code ?? '?'}）—\n` });
        emit('debug:exited', payload);
        session = null;
      } else if (type === 'error') {
        emit('console', { stream: 'err', text: payload + '\n' });
      } else {
        emit(`debug:${type}`, payload);
      }
    }
  );

  emit('console', { stream: 'info', text: `${dbg.kind} で起動します。\n` });
  const first = await session.start(bps);
  return { started: true, exe: r.exe, kind: dbg.kind, first, diagnostics: r.diagnostics };
});

handle('debug:cmd', async (cmd) => {
  if (!session) throw new Error('デバッグしていません');
  switch (cmd) {
    case 'continue': return session.continue_();
    case 'stepOver': return session.stepOver();
    case 'stepInto': return session.stepInto();
    case 'stepOut': return session.stepOut();
    case 'pause': return session.pause();
    default: throw new Error(`知らない指示です: ${cmd}`);
  }
});

handle('debug:addBreakpoint', async (file, line) => {
  if (!session) return false;
  return session.addBreakpoint(file, line);
});

// 呼び出し履歴で枠を選ぶ（選んだ枠の変数が見えます）
handle('debug:selectFrame', async (index) => {
  if (!session) throw new Error('デバッグしていません');
  return session.selectFrame(index);
});

handle('debug:evaluate', async (expr) => {
  if (!session) throw new Error('デバッグしていません');
  return session.evaluate(expr);
});

// 参照型（list / クラス / rc）の中身を 1 段開く（A-35）
handle('debug:expand', async (expr) => {
  if (!session) throw new Error('デバッグしていません');
  return session.expand(expr);
});

handle('debug:stdin', (data) => (session ? session.writeStdin(data) : false));

handle('debug:stop', async () => {
  if (!session) return false;
  await session.stop();
  session = null;
  return true;
});
