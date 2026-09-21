// 画面の全部。Arduino IDE と同じで「確認 → 実行」を最短で押せることを第一にしています。
'use strict';

/* ────────────────────────────────────────────────────────
   状態
   ──────────────────────────────────────────────────────── */
const S = {
  settings: null,
  root: '',                 // 開いているフォルダ
  tabs: new Map(),          // path -> { model, viewState, dirty, readonly }
  active: null,             // いま表示しているファイルのパス
  breakpoints: new Map(),   // path -> Set<line>
  bpState: new Map(),       // "path:line" -> true/false（デバッガが置けたか）
  mode: 'idle',             // idle | building | running | dbg-run | dbg-pause
  frames: [],
  frameIndex: 0,            // 呼び出し履歴のどの枠を見ているか
  vars: [],
  varFilter: '',
  expanded: new Set(),      // 開いている枝
  history: [],              // 定義へ移動する前の場所（戻る用）
  entry: '',                // 入口のファイル（複数ファイルのとき建てるもの）
};

let editor = null;
let monacoRef = null;
let decorations = null;     // ブレークポイントと現在行
let inlineValues = null;    // 行の右に出す「いまの値」

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const base = (p) => (p || '').split(/[\\/]/).pop();
const isYs = (p) => /\.ys$/i.test(p || '');

// main 側は { ok, value } を返します。失敗はまとめてここで拾います。
async function call(fn, ...args) {
  const r = await fn(...args);
  if (!r) return null;
  if (r.ok) return r.value;
  toast(r.error);
  return null;
}

function toast(msg) {
  writeConsole('err', msg + '\n');
  switchPanel('console');
}

/* ────────────────────────────────────────────────────────
   Monaco の用意
   ──────────────────────────────────────────────────────── */
self.MonacoEnvironment = {
  getWorkerUrl: () => '/src/renderer/monaco-worker.js',
};

require.config({ paths: { vs: '/node_modules/monaco-editor/min/vs' } });
require(['vs/editor/editor.main'], () => {
  monacoRef = window.monaco;
  registerYashirolang(monacoRef);
  boot();
});

function createEditor() {
  editor = monacoRef.editor.create($('editor'), {
    value: '',
    language: YS_LANGUAGE_ID,
    theme: S.settings.theme === 'light' ? 'yashiro-light' : 'yashiro-dark',
    fontSize: S.settings.fontSize,
    fontFamily: '"SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    automaticLayout: true,
    minimap: { enabled: false },
    glyphMargin: true,           // ← ブレークポイントを置く余白
    lineNumbersMinChars: 4,
    renderWhitespace: 'selection',
    tabSize: 4,
    insertSpaces: true,          // .ys はスペース 4 つ
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    contextmenu: true,
  });
  decorations = editor.createDecorationsCollection();
  inlineValues = editor.createDecorationsCollection();

  editor.onDidChangeCursorPosition((e) => {
    $('st-pos').textContent = `${e.position.lineNumber}:${e.position.column}`;
  });

  // 下の帯の「入口: …」を押すと、そのファイルを入口にできます。
  $('st-entry').onclick = () => {
    const p = currentYs();
    if (!p) return;
    setEntry(S.entry === p ? '' : p);
  };

  // 行番号の左をクリック → ブレークポイントの付け外し
  // ⌘（Windows / Linux は Ctrl）＋クリック → 定義へ移動
  editor.onMouseDown((e) => {
    const T = monacoRef.editor.MouseTargetType;
    if (e.target.type === T.GUTTER_GLYPH_MARGIN && S.active) {
      toggleBreakpoint(S.active, e.target.position.lineNumber);
      return;
    }
    const mod = e.event.metaKey || e.event.ctrlKey;
    if (mod && e.target.position && e.target.type === T.CONTENT_TEXT) {
      e.event.preventDefault();
      gotoDefinition(e.target.position);
    }
  });

  editor.addCommand(monacoRef.KeyCode.F9, () => {
    if (S.active) toggleBreakpoint(S.active, editor.getPosition().lineNumber);
  });

  wireNavigation();
  wireDebugKeys();
}

/* ────────────────────────────────────────────────────────
   定義へ移動 と、名前の上に出す説明
   ──────────────────────────────────────────────────────── */

// Monaco に「定義はここに訊いてください」と教えます。
// 答えを出すのは main 側（symbols.js）＝ コンパイラの `--dump-tokens` です。
function wireNavigation() {
  monacoRef.languages.registerDefinitionProvider(YS_LANGUAGE_ID, {
    provideDefinition: async (model, position) => {
      const file = pathOf(model);
      if (!file) return null;
      const d = await call(window.ide.symbols.definition, file, model.getValue(),
                           position.lineNumber - 1, position.column - 1);
      if (!d) return null;
      // ★ 行き先が別のファイルなら、中身を先に用意します
      //   （用意しないと Monaco は何も出せません）。
      const target = await ensureModel(d.file);
      if (!target) return null;
      return {
        uri: target.uri,
        range: new monacoRef.Range(d.line, d.column, d.line, d.column + (d.length || 1)),
      };
    },
  });

  // ★ 別のファイルへ飛ぶときは、こちらでタブを開きます。
  //   （Monaco 単体には「別のファイルを開く」係がいません。）
  //
  // ⚠️ Monaco の配布物によっては「定義へ移動」そのもの
  //   （editor.action.revealDefinition）が**入っていません**
  //   （0.56 の min ビルドには入っていませんでした）。
  //   だから F12 と ⌘＋クリックは、上の登録に頼らず
  //   **こちらで用意しています**（editor.addAction と onMouseDown）。
  //   登録のほうは、入っている版でピーク（覗き見）が出せるように残します。
  const svc = editor._codeEditorService;
  if (svc && typeof svc.openCodeEditor === 'function') {
    svc.openCodeEditor = async (input, source) => {
      const target = input.resource && (input.resource.fsPath || input.resource.path);
      if (!target) return source || editor;
      const sel = input.options && input.options.selection;
      remember();
      await gotoLocation(target, sel ? sel.startLineNumber : 1, sel ? sel.startColumn : 1);
      return editor;
    };
  }

  // F12（メニューと同じ）。上の仕掛けが無い版でも、これだけで飛べます。
  editor.addAction({
    id: 'ys.gotoDefinition',
    label: '定義へ移動',
    keybindings: [monacoRef.KeyCode.F12],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1,
    run: () => gotoDefinition(),
  });
  editor.addAction({
    id: 'ys.goBack',
    label: '戻る',
    keybindings: [monacoRef.KeyMod.Alt | monacoRef.KeyCode.LeftArrow],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 2,
    run: () => goBack(),
  });

  // 名前の上に出す説明。止まっているときは**いまの値**も出します。
  monacoRef.languages.registerHoverProvider(YS_LANGUAGE_ID, {
    provideHover: async (model, position) => {
      const file = pathOf(model);
      if (!file) return null;
      const parts = [];

      const value = await hoverValue(model, position);
      if (value) parts.push({ value });

      const info = await call(window.ide.symbols.hover, file, model.getValue(),
                              position.lineNumber - 1, position.column - 1);
      if (info && info.markdown) parts.push({ value: info.markdown });
      if (!parts.length) return null;
      return { contents: parts };
    },
  });
}

function pathOf(model) {
  return model && model.uri ? (model.uri.fsPath || model.uri.path) : null;
}

// 止まっているとき、カーソルの下の変数の値を読む。
//
// ⚠️ 読むのは **名前と `.` だけでできた式**に限ります（`xs[i]` や `f()` は
//   読みません）。式を評価すると関数が動いてしまい、見ただけのつもりが
//   プログラムの状態を変えてしまうからです。
async function hoverValue(model, position) {
  if (S.mode !== 'dbg-pause') return '';
  const expr = dottedWordAt(model, position);
  if (!expr) return '';
  const known = S.vars.find((v) => v.name === expr);
  if (known) return '`' + expr + '` = **' + known.value + '**' + (known.type ? '  _' + known.type + '_' : '');
  const out = await call(window.ide.debug.evaluate, expr);
  const line = String(out || '').trim().split('\n').pop();
  if (!line || /error:|no variable|No symbol/i.test(line)) return '';
  return '`' + expr + '` = **' + line.replace(/^\(.*?\)\s*\$\d+\s*=\s*/, '') + '**';
}

// カーソルの下の `a.b.c`（名前と `.` だけ）
function dottedWordAt(model, position) {
  const word = model.getWordAtPosition(position);
  if (!word) return '';
  const before = model.getValueInRange({
    startLineNumber: position.lineNumber, startColumn: 1,
    endLineNumber: position.lineNumber, endColumn: word.startColumn,
  });
  const head = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.)$/.exec(before);
  const after = model.getValueInRange({
    startLineNumber: position.lineNumber, startColumn: word.endColumn,
    endLineNumber: position.lineNumber, endColumn: word.endColumn + 1,
  });
  if (after === '(') return '';           // 関数呼び出しは読みません
  return (head ? head[1] : '') + word.word;
}

// いまの場所を覚えてから飛ぶ（Alt+← で戻れます）
function remember() {
  if (!S.active || !editor) return;
  const pos = editor.getPosition();
  S.history.push({ file: S.active, line: pos.lineNumber, column: pos.column });
  if (S.history.length > 50) S.history.shift();
}

async function gotoDefinition(position) {
  if (!S.active || !editor) return;
  if (!position && twice('goto-definition')) return;
  const pos = position || editor.getPosition();
  const d = await call(window.ide.symbols.definition, S.active, editor.getModel().getValue(),
                       pos.lineNumber - 1, pos.column - 1);
  if (!d) {
    writeConsole('info', '定義が分かりませんでした（式の型が要る名前は追えません）。\n');
    return;
  }
  remember();
  await gotoLocation(d.file, d.line, d.column);
}

async function goBack() {
  if (twice('go-back')) return;
  const back = S.history.pop();
  if (!back) return;
  await gotoLocation(back.file, back.line, back.column);
}

/* ────────────────────────────────────────────────────────
   デバッグのキー（F5 / F8 / F10 / F11 / ⇧F11）
   ──────────────────────────────────────────────────────── */
//
// ★ メニューにも同じキーを付けてあります。どちらから来ても
//   通り道は 1 本（dbg / doDebug）で、**二重に進まない**ように
//   「返事待ちのあいだは受け取らない」で守っています。
function wireDebugKeys() {
  const K = monacoRef.KeyCode;
  const M = monacoRef.KeyMod;
  const bind = (keys, fn) => editor.addCommand(keys, fn);
  bind(K.F5, () => debugOrContinue());
  bind(M.Shift | K.F5, () => doStop());
  bind(K.F6, () => doPause());
  bind(K.F8, () => dbg('resume'));
  bind(K.F10, () => dbg('stepOver'));
  bind(K.F11, () => dbg('stepInto'));
  bind(M.Shift | K.F11, () => dbg('stepOut'));

  // エディタの外（木・出力欄）にカーソルがあるときも同じキーで動かせます。
  window.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const map = {
      F5: () => (e.shiftKey ? doStop() : debugOrContinue()),
      F6: () => doPause(),
      F8: () => dbg('resume'),
      F10: () => dbg('stepOver'),
      F11: () => (e.shiftKey ? dbg('stepOut') : dbg('stepInto')),
    };
    if (!map[e.key]) return;
    e.preventDefault();
    map[e.key]();
  });
}

/* ────────────────────────────────────────────────────────
   起動
   ──────────────────────────────────────────────────────── */
async function boot() {
  S.settings = await call(window.ide.settings.get);
  document.body.dataset.theme = S.settings.theme;
  createEditor();
  wireToolbar();
  wireTree();
  wirePanel();
  wireSettings();
  window.ide.on('app:event', onAppEvent);

  refreshToolchain();

  wireLibrary();

  // 自己点検（test/smoke.js）から画面の中を覗くための窓口。
  // ここから触れるのは画面の関数だけで、ファイルや OS には届きません。
  window.__ide = {
    S, get editor() { return editor; },
    toggleBreakpoint, openFile, doCheck, doRun, doDebug, doStop, dbg,
    gotoDefinition, goBack, selectFrame, setEntry, targetFile, debugOrContinue, doPause,
    // 名前の上に出す「いまの値」を、点検から確かめるための入口
    hoverAt: (lineNumber, column) => hoverValue(editor.getModel(), { lineNumber, column }),
  };

  // 前に開いていたフォルダがあれば、そのまま開き直します。
  if (S.settings.lastFolder) {
    const t = await call(window.ide.fs.tree, S.settings.lastFolder);
    if (t) setRoot(t.root, t.items);
  }
  setMode('idle');
}

async function refreshToolchain() {
  const t = await call(window.ide.toolchain.detect);
  if (!t) return;
  S.tool = t;
  if (!t.compiler) {
    $('st-tool').textContent = 'コンパイラが見つかりません（⚙ から指定できます）';
    $('st-tool').style.color = 'var(--err)';
  } else {
    $('st-tool').style.color = '';
    $('st-tool').textContent = `${t.compilerVersion || base(t.compiler)}${t.debuggerKind ? ' / ' + t.debuggerKind : ''}`;
    $('st-tool').title = t.compiler;
  }
}

/* ────────────────────────────────────────────────────────
   フォルダの木
   ──────────────────────────────────────────────────────── */
function setRoot(root, items) {
  S.root = root;
  // ★ 入口はフォルダごとに覚えています。
  S.entry = (S.settings.entries || {})[root] || '';
  renderEntry();
  loadLibrary();
  $('root-name').textContent = base(root);
  $('root-name').title = root;
  const tree = $('tree');
  tree.innerHTML = '';
  renderNodes(tree, items, 0);
}

function renderNodes(container, items, depth) {
  for (const it of items) {
    const node = el('div', 'node' + (it.dir ? ' dir' : '') + (isYs(it.path) ? ' ys' : ''));
    node.style.paddingLeft = 8 + depth * 13 + 'px';
    node.dataset.path = it.path;
    node.dataset.dir = String(it.dir);

    const tw = el('span', 'tw', it.dir ? (S.expanded.has(it.path) ? '▾' : '▸') : '');
    const ic = el('span', 'ic', it.dir ? '📁' : isYs(it.path) ? '◆' : '📄');
    const nm = el('span', 'nm', it.name);
    node.append(tw, ic, nm);
    container.append(node);

    if (it.dir) {
      const kids = el('div', 'kids');
      kids.dataset.for = it.path;
      kids.style.display = S.expanded.has(it.path) ? '' : 'none';
      container.append(kids);
      if (S.expanded.has(it.path)) loadInto(kids, it.path, depth + 1);
    }
  }
}

async function loadInto(container, dir, depth) {
  const t = await call(window.ide.fs.tree, dir);
  if (!t) return;
  container.innerHTML = '';
  renderNodes(container, t.items, depth);
}

function depthOf(node) {
  return Math.round((parseInt(node.style.paddingLeft, 10) - 8) / 13);
}

function wireTree() {
  $('btn-open-folder').onclick = openFolder;
  $('btn-refresh').onclick = async () => {
    if (!S.root) return;
    const t = await call(window.ide.fs.tree, S.root);
    if (t) setRoot(t.root, t.items);
  };
  $('btn-new-file').onclick = () => newEntry(false);
  $('btn-new-folder').onclick = () => newEntry(true);

  $('tree').addEventListener('click', async (e) => {
    const node = e.target.closest('.node');
    if (!node) return;
    document.querySelectorAll('#tree .node.active').forEach((n) => n.classList.remove('active'));
    node.classList.add('active');
    const p = node.dataset.path;

    if (node.dataset.dir === 'true') {
      const kids = node.nextElementSibling;
      const open = S.expanded.has(p);
      if (open) {
        S.expanded.delete(p);
        kids.style.display = 'none';
        node.querySelector('.tw').textContent = '▸';
      } else {
        S.expanded.add(p);
        kids.style.display = '';
        node.querySelector('.tw').textContent = '▾';
        await loadInto(kids, p, depthOf(node) + 1);
      }
    } else {
      openFile(p);
    }
  });

  // 右クリックの代わりに、選んだ物への操作はキーで
  $('tree').addEventListener('keydown', async (e) => {
    const sel = document.querySelector('#tree .node.active');
    if (!sel) return;
    if (e.key === 'F2') {
      const name = await askName('名前の変更', base(sel.dataset.path), '変更');
      if (name) {
        const np = await call(window.ide.fs.rename, sel.dataset.path, name);
        if (np) { renameTab(sel.dataset.path, np); $('btn-refresh').click(); }
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const ok = await window.ide.dialog.confirm({
        message: `${base(sel.dataset.path)} をごみ箱に入れますか？`,
        okLabel: 'ごみ箱へ',
      });
      if (ok && ok.value) {
        await call(window.ide.fs.remove, sel.dataset.path);
        closeTab(sel.dataset.path, true);
        $('btn-refresh').click();
      }
    }
  });
}

/* ── ライブラリ（読むだけ）────────────────────────
 *
 * ★ `import strings` と書いたときに読まれる物が、そのまま並びます。
 *   置き場所は処理系に訊いています（`--print-lib-dir`）。
 *   ysm を使っている木なら `deps/` も出ます。
 */
async function wireLibrary() {
  const head = $('lib-head');
  const box = $('lib-tree');
  head.onclick = async () => {
    const open = box.style.display !== 'none';
    box.style.display = open ? 'none' : '';
    head.querySelector('.tw').textContent = open ? '▸' : '▾';
    if (!open) await loadLibrary();
  };
}

async function loadLibrary() {
  const box = $('lib-tree');
  box.innerHTML = '';
  const groups = await call(window.ide.fs.library);
  if (!groups || !groups.length) {
    box.append(Object.assign(el('div', 'empty small'),
      { textContent: 'コンパイラが見つからないので、ライブラリの場所が分かりません。' }));
    return;
  }
  for (const g of groups) {
    const head = el('div', 'lib-group', g.name);
    head.title = g.dir;
    box.append(head);
    for (const it of g.items) {
      if (it.dir) continue;
      if (!isYs(it.path)) continue;
      const node = el('div', 'node ys lib');
      node.style.paddingLeft = '21px';
      node.append(el('span', 'tw', ''), el('span', 'ic', '◆'),
                  el('span', 'nm', it.name.replace(/\.ys$/, '')));
      node.title = it.path;
      node.onclick = () => openFile(it.path);
      box.append(node);
    }
  }
}

async function openFolder() {
  const r = await call(window.ide.dialog.openFolder);
  if (!r) return;
  S.expanded.clear();
  setRoot(r.root, r.items);
}

// 新しいファイル／フォルダは「いま選んでいるフォルダ」の中に作ります。
function currentDir() {
  const sel = document.querySelector('#tree .node.active');
  if (sel) {
    return sel.dataset.dir === 'true'
      ? sel.dataset.path
      : sel.dataset.path.replace(/[\\/][^\\/]+$/, '');
  }
  if (S.active) return S.active.replace(/[\\/][^\\/]+$/, '');
  return S.root;
}

async function newEntry(isDir) {
  if (!S.root) { toast('先にフォルダを開いてください。'); return; }
  const name = await askName(isDir ? '新しいフォルダ' : '新しいファイル', isDir ? '' : 'main.ys', '作成');
  if (!name) return;
  const dir = currentDir();
  const p = isDir
    ? await call(window.ide.fs.createFolder, dir, name)
    : await call(window.ide.fs.createFile, dir, name);
  if (!p) return;
  const t = await call(window.ide.fs.tree, S.root);
  if (t) setRoot(t.root, t.items);
  if (!isDir) openFile(p);
}

function askName(title, value, okLabel) {
  return new Promise((resolve) => {
    const dlg = $('name-dialog');
    $('name-title').textContent = title;
    const input = $('name-input');
    input.value = value || '';
    dlg.querySelector('menu button.primary').textContent = okLabel || 'OK';
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null);
    dlg.showModal();
    input.focus();
    input.setSelectionRange(0, (value || '').replace(/\.[^.]*$/, '').length);
  });
}

/* ────────────────────────────────────────────────────────
   タブとエディタ
   ──────────────────────────────────────────────────────── */
// ★ 開く先は「開いているフォルダの中」だけではありません。
//   import した先で止まったときや、定義へ移動で標準ライブラリへ飛んだときは、
//   **読むだけ**のタブとして開きます（🔒 が付きます）。
async function openFile(p) {
  if (S.tabs.has(p)) return activateTab(p);
  const opened = await call(window.ide.fs.open, p);
  if (!opened) return;
  const uri = monacoRef.Uri.file(p);
  const model = monacoRef.editor.getModel(uri)
    || monacoRef.editor.createModel(opened.text, isYs(p) ? YS_LANGUAGE_ID : undefined, uri);
  model.onDidChangeContent(() => markDirty(p, true));
  S.tabs.set(p, { model, viewState: null, dirty: false, readonly: !!opened.readonly });
  renderTabs();
  activateTab(p);
}

// Monaco の「定義へ移動」は行き先のモデルを先に要ります。
// タブにはしないで、中身だけ用意しておきます。
async function ensureModel(p) {
  const uri = monacoRef.Uri.file(p);
  const has = monacoRef.editor.getModel(uri);
  if (has) return has;
  const opened = await call(window.ide.fs.open, p);
  if (!opened) return null;
  return monacoRef.editor.createModel(opened.text, isYs(p) ? YS_LANGUAGE_ID : undefined, uri);
}

function activateTab(p) {
  const tab = S.tabs.get(p);
  if (!tab) return;
  if (S.active && S.tabs.has(S.active)) S.tabs.get(S.active).viewState = editor.saveViewState();
  S.active = p;
  editor.setModel(tab.model);
  editor.updateOptions({ readOnly: !!tab.readonly });
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  editor.focus();
  $('editor-empty').style.display = 'none';
  $('st-file').textContent = p + (tab.readonly ? '（読むだけ）' : '');
  renderEntry();
  renderTabs();
  paintDecorations();
  paintInlineValues();
}

function markDirty(p, dirty) {
  const t = S.tabs.get(p);
  if (!t || t.dirty === dirty) return;
  t.dirty = dirty;
  renderTabs();
}

function renderTabs() {
  const bar = $('tabs');
  bar.innerHTML = '';
  for (const [p, t] of S.tabs) {
    const tab = el('div', 'tab' + (p === S.active ? ' active' : '') + (t.dirty ? ' dirty' : '')
                   + (t.readonly ? ' ro' : '') + (p === S.entry ? ' entry' : ''));
    tab.title = p + (t.readonly ? '\n（開いているフォルダの外なので、読むだけです）' : '');
    tab.append(el('span', 'nm', (t.readonly ? '🔒 ' : '') + base(p)));
    const x = el('span', 'x', '×');
    x.onclick = (e) => { e.stopPropagation(); closeTab(p); };
    tab.append(x);
    tab.onclick = () => activateTab(p);
    bar.append(tab);
  }
}

async function closeTab(p, force) {
  const t = S.tabs.get(p);
  if (!t) return;
  if (t.dirty && !force) {
    const r = await window.ide.dialog.confirm({
      message: `${base(p)} の変更を保存しますか？`,
      detail: '「はい」で保存してから閉じます。',
      okLabel: '保存して閉じる',
    });
    if (r && r.value) await saveFile(p);
  }
  t.model.dispose();
  S.tabs.delete(p);
  if (S.active === p) {
    S.active = null;
    const next = S.tabs.keys().next();
    if (!next.done) activateTab(next.value);
    else {
      editor.setModel(null);
      $('editor-empty').style.display = '';
      $('st-file').textContent = '—';
    }
  }
  renderTabs();
}

function renameTab(oldPath, newPath) {
  if (!S.tabs.has(oldPath)) return;
  const t = S.tabs.get(oldPath);
  S.tabs.delete(oldPath);
  S.tabs.set(newPath, t);
  if (S.active === oldPath) S.active = newPath;
  renderTabs();
}

async function saveFile(p) {
  const t = S.tabs.get(p);
  if (!t) return false;
  // ⚠️ 標準ライブラリなどは読むだけです。黙って捨てずに、そう言います。
  if (t.readonly) {
    toast(`${base(p)} は開いているフォルダの外にあるので保存できません。`);
    return false;
  }
  const ok = await call(window.ide.fs.write, p, t.model.getValue());
  if (ok) markDirty(p, false);
  return !!ok;
}

async function saveAll() {
  for (const [p, t] of S.tabs) if (t.dirty) await saveFile(p);
}

/* ────────────────────────────────────────────────────────
   ブレークポイント と 現在行
   ──────────────────────────────────────────────────────── */
function bpSet(p) {
  if (!S.breakpoints.has(p)) S.breakpoints.set(p, new Set());
  return S.breakpoints.get(p);
}

function toggleBreakpoint(p, line) {
  const set = bpSet(p);
  if (set.has(line)) {
    set.delete(line);
    S.bpState.delete(p + ':' + line);
  } else {
    set.add(line);
    // デバッグ中なら、その場で足します。
    // ★ 置けたかどうか（その行が実行ファイルに入っているか）を持ち帰ります。
    if (S.mode.startsWith('dbg')) {
      call(window.ide.debug.addBreakpoint, p, line).then((st) => {
        if (st && typeof st === 'object') {
          S.bpState.set(p + ':' + line, st.resolved);
          renderBreakpointList();
        }
      });
    }
  }
  paintDecorations();
  renderBreakpointList();
}

function clearBreakpoints() {
  S.breakpoints.clear();
  paintDecorations();
  renderBreakpointList();
}

function paintDecorations() {
  if (!editor || !S.active) return;
  const list = [];
  for (const line of bpSet(S.active)) {
    list.push({
      range: new monacoRef.Range(line, 1, line, 1),
      options: { isWholeLine: false, glyphMarginClassName: 'ys-breakpoint',
                 glyphMarginHoverMessage: { value: 'ブレークポイント' }, stickiness: 1 },
    });
  }
  if (S.stopAt && S.stopAt.file === S.active && S.stopAt.line) {
    list.push({
      range: new monacoRef.Range(S.stopAt.line, 1, S.stopAt.line, 1),
      options: { isWholeLine: true, className: 'ys-current-line',
                 glyphMarginClassName: 'ys-current-glyph' },
    });
  }
  decorations.set(list);
}

/* ── 行の右に出す「いまの値」───────────────────────
 *
 * ★ 止まっている関数の中だけ、変数の**いまの値**を行の右に薄く出します。
 *   マウスを当てなくても、目で追えるようにするためです。
 *
 * ⚠️ 出すのは「その行で名前が出てくる変数」だけです。全部出すと、
 *   関係ない行まで埋まって読めなくなります。
 */
function paintInlineValues() {
  if (!editor || !inlineValues) return;
  // ⚠️ 止まった行が分からないとき（系統の奥で止まったとき）は、
  //   何も出しません。当てずっぽうの行に値を並べないためです。
  if (S.mode !== 'dbg-pause' || !S.stopAt || !S.stopAt.line
      || S.stopAt.file !== S.active || !S.vars.length) {
    inlineValues.clear();
    return;
  }
  const model = editor.getModel();
  if (!model) return;

  const stopLine = S.stopAt.line;
  const from = functionStart(model, stopLine);
  const list = [];
  for (let line = from; line <= Math.min(stopLine, model.getLineCount()); line++) {
    const text = model.getLineContent(line);
    const here = [];
    for (const v of S.vars) {
      if (new RegExp('\\b' + v.name + '\\b').test(text)) here.push(`${v.name} = ${short(v.value)}`);
    }
    if (!here.length) continue;
    list.push({
      range: new monacoRef.Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line)),
      options: {
        after: { content: '   ' + here.join(', '), inlineClassName: 'ys-inline-value' },
        showIfCollapsed: true,
      },
    });
  }
  inlineValues.set(list);
}

// 止まっている行から上へたどって、その関数の始まりを探す。
function functionStart(model, line) {
  for (let n = line; n >= 1; n--) {
    if (/^\s*def\s/.test(model.getLineContent(n))) return n;
  }
  return 1;
}

function short(v) {
  const s = String(v == null ? '' : v);
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}

function renderBreakpointList() {
  const box = $('bplist');
  box.innerHTML = '';
  let n = 0;
  for (const [p, set] of S.breakpoints) {
    for (const line of [...set].sort((a, b) => a - b)) {
      n++;
      const placed = S.bpState.get(p + ':' + line);
      const row = el('div', 'bp' + (placed === false ? ' unresolved' : ''));
      if (placed === false) row.title = 'この行は実行ファイルに入っていません'
        + '（入口から import されていないファイルです）。';
      row.append(el('span', 'nm', base(p)), el('span', 'fl', `:${line}`));
      const rm = el('span', 'rm', '×');
      rm.onclick = (e) => { e.stopPropagation(); toggleBreakpoint(p, line); };
      row.append(rm);
      row.onclick = () => gotoLocation(p, line);
      box.append(row);
    }
  }
  if (!n) box.append(Object.assign(el('div', 'empty small'), { textContent: '行番号の左をクリックすると付きます。' }));
}

async function gotoLocation(p, line, column) {
  if (!p) return;
  await openFile(p);
  if (!line) return;
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: column || 1 });
  editor.focus();
}

function allBreakpoints() {
  const out = [];
  for (const [p, set] of S.breakpoints) for (const line of set) out.push({ file: p, line });
  return out;
}

/* ────────────────────────────────────────────────────────
   ツールバーの動き
   ──────────────────────────────────────────────────────── */
function wireToolbar() {
  $('btn-check').onclick = doCheck;
  $('btn-run').onclick = doRun;
  $('btn-stop').onclick = doStop;
  $('btn-debug').onclick = doDebug;
  // ★ 1 つのボタンが 2 役です。走っている間は ⏸（一時停止）、
  //   止まっている間は ⏵（続行）。VS Code と同じ並びにしています。
  $('btn-continue').onclick = () => (S.mode === 'dbg-run' ? doPause() : dbg('resume'));
  $('btn-step-over').onclick = () => dbg('stepOver');
  $('btn-step-into').onclick = () => dbg('stepInto');
  $('btn-step-out').onclick = () => dbg('stepOut');
  $('btn-settings').onclick = openSettings;
}

// 「いまビルドすべきファイル」。
//
// ★ 複数ファイルのときは **入口（`def main()` のあるファイル）**を建てます。
//   util.ys を開いたまま ▶ を押しても、建つのは main.ys です。
//   （処理系は入口から import をたどって、まとめて 1 つの実行ファイルにします。）
//
// 決め方は次の順です。
//   ① 「このファイルを入口にする」で指定したもの（フォルダごとに覚えます）
//   ② いま開いている .ys に `def main(` があれば、それ
//   ③ フォルダの中で `def main(` があるのが 1 つだけなら、それ
//   ④ それ以外は、いま開いている .ys
let lastYs = null;

function currentYs() {
  if (isYs(S.active)) { lastYs = S.active; return S.active; }
  if (lastYs && S.tabs.has(lastYs)) return lastYs;
  for (const p of S.tabs.keys()) if (isYs(p)) return p;
  return null;
}

function hasMain(p) {
  const t = S.tabs.get(p);
  return !!(t && /^\s*def\s+main\s*\(/m.test(t.model.getValue()));
}

async function targetFile() {
  if (S.entry) return S.entry;
  const here = currentYs();
  if (!here) return null;
  if (hasMain(here)) return here;

  // 開いていないファイルのことは main 側に訊きます（木を 1 回だけ歩きます）。
  const found = await call(window.ide.fs.entries);
  if (found && found.length === 1 && found[0] !== here) {
    writeConsole('info', `入口は ${base(found[0])} です（${base(here)} に def main() がないため）。\n`);
    return found[0];
  }
  if (found && found.length > 1 && !found.includes(here)) {
    writeConsole('info',
      `def main() のあるファイルが ${found.length} 個あります。`
      + '「スケッチ → このファイルを入口にする」で決められます:\n'
      + found.map((f) => '    ' + base(f)).join('\n') + '\n');
  }
  return here;
}

function setEntry(p) {
  S.entry = p || '';
  const entries = { ...(S.settings.entries || {}) };
  if (S.root) {
    if (p) entries[S.root] = p;
    else delete entries[S.root];
    S.settings = { ...S.settings, entries };
    window.ide.settings.set({ entries });
  }
  renderEntry();
  renderTabs();
}

function renderEntry() {
  const box = $('st-entry');
  const shown = S.entry || currentYs();
  box.textContent = shown ? `入口: ${base(shown)}${S.entry ? '' : '（自動）'}` : '';
  box.title = shown ? shown : '';
}

async function prepare() {
  const src = await targetFile();
  if (!src) { toast('.ys のファイルを開いてください。'); return null; }
  if (S.settings.autoSaveBeforeBuild) await saveAll();
  clearProblems();
  switchPanel('console');
  return src;
}

async function doCheck() {
  const src = await prepare();
  if (!src) return;
  setMode('building');
  const r = await call(window.ide.build.check, src);
  setMode('idle');
  if (r) showProblems(r.diagnostics);
}

async function doRun() {
  if (S.mode === 'running' || S.mode === 'building') return;
  if (twice('run')) return;
  const src = await prepare();
  if (!src) return;
  setMode('building');
  const r = await call(window.ide.run.start, src);
  if (!r || !r.started) { setMode('idle'); if (r) showProblems(r.diagnostics); return; }
  showProblems(r.diagnostics);
  setMode('running');
}

async function doDebug() {
  if (S.mode.startsWith('dbg') || S.mode === 'building') return;
  if (twice('debug')) return;
  const src = await prepare();
  if (!src) return;
  setMode('building');
  switchPanel('debug');
  const r = await call(window.ide.debug.start, src, allBreakpoints());
  if (!r || !r.started) { setMode('idle'); if (r) showProblems(r.diagnostics); return; }
  showProblems(r.diagnostics);
  if (!allBreakpoints().length) {
    writeConsole('info', 'ブレークポイントがないので、そのまま最後まで走ります。\n');
  }
}

async function doStop() {
  if (S.mode.startsWith('dbg')) await window.ide.debug.stop();
  else if (S.mode === 'running') await window.ide.run.stop();
  else await window.ide.build.cancel();
  setMode('idle');
}

// ★ キーは「メニュー」と「エディタ」の 2 か所から来ます。
//   同じ指示が 2 回届いても **2 歩進まない**ように、
//   返事が返るまでは次を受け取りません。
let dbgBusy = false;

// 同じ指示が続けて 2 回来たときの二重起動よけ（キーは両方から届きます）。
const lastFired = new Map();
function twice(key, ms = 400) {
  const now = Date.now();
  const at = lastFired.get(key) || 0;
  lastFired.set(key, now);
  return now - at < ms;
}

async function dbg(cmd) {
  if (!S.mode.startsWith('dbg')) return;
  if (S.mode !== 'dbg-pause') return;      // 走っている間は受け取りません
  if (dbgBusy) return;
  dbgBusy = true;
  setMode('dbg-run');
  try {
    await call(window.ide.debug[cmd]);
  } finally {
    dbgBusy = false;
  }
}

// ⏸ 一時停止。走っている対象に割り込んで、いまいる行で止めます。
//
// ★ 止まったことは 'stopped' の知らせで届きます（ブレークポイントで
//   止まったときと同じ道）。ここでは送るだけです。
async function doPause() {
  if (S.mode !== 'dbg-run') return;
  if (twice('pause')) return;
  const ok = await call(window.ide.debug.pause);
  if (ok === false) {
    writeConsole('info',
      '一時停止できませんでした（対象がもう終わっているか、この環境では割り込めません）。\n');
  }
}

// F5 …… 止まっているなら続行、そうでなければデバッグ実行を始める。
function debugOrContinue() {
  if (S.mode === 'dbg-pause') return dbg('resume');
  if (S.mode.startsWith('dbg') || S.mode === 'building') return;
  return doDebug();
}

/* ────────────────────────────────────────────────────────
   画面の状態（ボタンの有効・無効）
   ──────────────────────────────────────────────────────── */
function setMode(mode) {
  // ⚠️ 二重配達よけ（twice）は、**状態が変わったら忘れます**。
  //   「止める → 続ける → また止める」を続けて押したとき、
  //   2 回目を「二重配達」と間違えて捨てないためです。
  if (S.mode !== mode) lastFired.clear();
  S.mode = mode;
  const dbgOn = mode === 'dbg-pause';
  const busy = mode === 'building';
  const live = mode === 'running' || mode.startsWith('dbg');

  $('btn-check').disabled = busy || live;
  $('btn-run').disabled = busy || live;
  $('btn-debug').disabled = busy || live;
  $('btn-stop').disabled = !(busy || live);
  for (const id of ['btn-step-over', 'btn-step-into', 'btn-step-out']) {
    $(id).disabled = !dbgOn;
  }

  // ⏵ / ⏸ の 1 つのボタン。走っている間だけ ⏸ になります。
  const cont = $('btn-continue');
  const pausing = mode === 'dbg-run';
  cont.textContent = pausing ? '⏸' : '⏵';
  cont.title = pausing ? '一時停止（F6）' : '続行（F8）';
  cont.classList.toggle('pausing', pausing);
  cont.disabled = !(dbgOn || pausing);
  $('stdin').disabled = !live;
  $('eval-input').disabled = !dbgOn;

  const pill = $('state-pill');
  pill.className = 'pill';
  if (busy) { pill.textContent = 'ビルド中…'; pill.classList.add('busy'); }
  else if (mode === 'running') { pill.textContent = '実行中'; pill.classList.add('running'); }
  else if (mode === 'dbg-run') { pill.textContent = 'デバッグ実行中'; pill.classList.add('running'); }
  else if (mode === 'dbg-pause') { pill.textContent = '停止中（デバッグ）'; pill.classList.add('paused'); }
  else pill.textContent = '待機中';

  if (mode === 'idle') {
    S.stopAt = null;
    S.frameIndex = 0;
    $('frame-label').textContent = '';
    paintDecorations();
    if (inlineValues) inlineValues.clear();
  }
  $('var-filter').disabled = !dbgOn;
  if (mode !== 'dbg-pause' && inlineValues) inlineValues.clear();
}

/* ────────────────────────────────────────────────────────
   下のパネル
   ──────────────────────────────────────────────────────── */
function wirePanel() {
  document.querySelectorAll('.ptab').forEach((b) => {
    b.onclick = () => switchPanel(b.dataset.panel);
  });
  $('btn-clear-console').onclick = () => { $('console').textContent = ''; };

  $('stdin').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const line = e.target.value + '\n';
    e.target.value = '';
    writeConsole('info', '> ' + line);
    if (S.mode.startsWith('dbg')) window.ide.debug.stdin(line);
    else window.ide.run.stdin(line);
  });

  $('var-filter').addEventListener('input', (e) => {
    S.varFilter = e.target.value;
    renderVars();
  });

  $('eval-input').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const expr = e.target.value.trim();
    if (!expr) return;
    const out = await call(window.ide.debug.evaluate, expr);
    const row = el('div', 'var evaled');
    row.append(el('span', 'tw', ' '));
    row.append(el('span', 'nm', expr));
    row.append(el('span', 'eq', '='));
    row.append(el('span', 'vl', String(out || '').trim().split('\n').pop()));
    $('locals').prepend(row);
    e.target.value = '';
  });

  // 仕切りをドラッグして幅と高さを変える
  drag($('splitter-x'), 'x', (dx) => {
    const side = $('sidebar');
    side.style.width = Math.min(520, Math.max(150, side.offsetWidth + dx)) + 'px';
  });
  drag($('splitter-y'), 'y', (dy) => {
    const panel = $('panel');
    panel.style.height = Math.min(window.innerHeight - 220, Math.max(28, panel.offsetHeight - dy)) + 'px';
  });
}

function drag(handle, axis, apply) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    let last = axis === 'x' ? e.clientX : e.clientY;
    const move = (ev) => {
      const now = axis === 'x' ? ev.clientX : ev.clientY;
      apply(now - last);
      last = now;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function switchPanel(name) {
  document.querySelectorAll('.ptab').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel-page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
}

function writeConsole(stream, text) {
  const box = $('console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const span = el('span', 's-' + stream, text);
  box.append(span);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ── 問題一覧 ───────────────────────────────── */
function clearProblems() {
  showProblems([]);
}

function showProblems(diags) {
  diags = diags || [];
  const box = $('problems');
  box.innerHTML = '';
  const count = diags.filter((d) => d.severity === 'error').length;
  const badge = $('problem-count');
  badge.textContent = String(diags.length);
  badge.classList.toggle('hot', count > 0);

  if (!diags.length) {
    box.append(Object.assign(el('div', 'empty small'), { textContent: '問題はありません。' }));
  }
  for (const d of diags) {
    const row = el('div', 'prob ' + d.severity);
    row.append(el('span', 'sv', d.severity === 'error' ? '✖' : '⚠'));
    const msg = el('div', 'msg');
    msg.append(document.createTextNode(d.message));
    if (d.label) msg.append(el('span', 'sub', d.label));
    for (const det of d.details || []) msg.append(el('span', 'sub', '— ' + det.message));
    row.append(msg);
    if (d.file) row.append(el('span', 'where', `${base(d.file)}:${d.line}:${d.column}`));
    row.onclick = () => gotoLocation(d.file, d.line, d.column);
    box.append(row);
  }

  applyMarkers(diags);
  if (diags.length) switchPanel('problems');
}

// エディタの中にも波線を出す。
//
// ★ import した先のエラーは、**まだ開いていないファイル**に出ます。
//   そのファイルの中身を先に用意して、開いたときにはもう波線が
//   出ているようにします（開いてから出ると、見落とすからです）。
async function applyMarkers(diags) {
  if (!monacoRef) return;
  const byFile = new Map();
  for (const d of diags) {
    if (!d.file || !d.line) continue;
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push({
      severity: d.severity === 'error'
        ? monacoRef.MarkerSeverity.Error
        : monacoRef.MarkerSeverity.Warning,
      message: [d.message, d.label, ...(d.details || []).map((x) => x.message)].filter(Boolean).join('\n'),
      startLineNumber: d.line, startColumn: d.column || 1,
      endLineNumber: d.line, endColumn: (d.column || 1) + (d.label ? 3 : 1),
    });
  }
  // まだ無いファイルの中身を用意する（エラーの出ているファイルだけ）
  for (const p of byFile.keys()) {
    if (!monacoRef.editor.getModel(monacoRef.Uri.file(p))) await ensureModel(p);
  }
  for (const model of monacoRef.editor.getModels()) {
    const p = model.uri.fsPath || model.uri.path;
    monacoRef.editor.setModelMarkers(model, 'yashirolang', byFile.get(p) || []);
  }
}

// いまの yashirolang は -g で **行の情報だけ** を出します（変数の DWARF はまだ）。
// デバッガの生のエラーをそのまま見せると戸惑うので、言い換えます。
/* ── 変数 ───────────────────────────────────────
 *
 * ★ 言語側が 0.28.0（A-35）から変数の名前と型を出すので、
 *   ここに中身が並びます。list とクラスと rc は **開けます**。
 *
 * ⚠️ 開けなかったとき（古いコンパイラ・最適化つき）は、デバッガが返した
 *   生の文字列をそのまま出します。**黙って空にはしません。**
 */
function showVars(vars, rawText) {
  S.vars = vars || [];
  renderVars(rawText);
}

// ★ 引数とローカル変数を分けて並べます（どれが渡ってきた物かが
//   分かると、呼び出し側を疑うか中を疑うかが決められます）。
function renderVars(rawText) {
  const box = $('locals');
  box.innerHTML = '';

  if (!S.vars.length) {
    const why = explainNoVars(rawText === undefined ? S.varsRaw : rawText);
    box.append(Object.assign(el('div', 'empty small'), { textContent: why }));
    return;
  }
  if (rawText !== undefined) S.varsRaw = rawText;

  const needle = S.varFilter.trim().toLowerCase();
  const shown = needle
    ? S.vars.filter((v) => v.name.toLowerCase().includes(needle))
    : S.vars;

  const groups = [
    ['引数', shown.filter((v) => v.arg)],
    ['ローカル変数', shown.filter((v) => !v.arg)],
  ];
  for (const [title, list] of groups) {
    if (!list.length) continue;
    box.append(el('div', 'vargroup-head', title));
    for (const v of list) box.append(varRow(v, v.name, 0));
  }
  if (!shown.length) {
    box.append(Object.assign(el('div', 'empty small'),
                             { textContent: `「${S.varFilter}」に合う変数はありません。` }));
  }
}

function varRow(v, expr, depth) {
  const row = el('div', 'var');
  row.style.paddingLeft = (10 + depth * 14) + 'px';

  const twisty = el('span', 'tw', v.openable ? '▸' : ' ');
  row.append(twisty);
  row.append(el('span', 'nm', v.name));
  row.append(el('span', 'eq', '='));
  row.append(el('span', 'vl', v.value));
  if (v.type) row.append(el('span', 'ty', v.type));

  if (!v.openable) return row;

  const wrap = el('div', 'vargroup');
  wrap.append(row);
  let open = false;
  let loaded = false;
  row.onclick = async () => {
    open = !open;
    twisty.textContent = open ? '▾' : '▸';
    if (!open) {
      while (wrap.children.length > 1) wrap.lastChild.remove();
      return;
    }
    if (!loaded) {
      const kids = await call(window.ide.debug.expand, expr);
      loaded = true;
      wrap.__kids = kids || [];
    }
    for (const k of (wrap.__kids || [])) {
      // ⚠️ 開いた先をさらに開くときの式は `expr->name` です
      //   （どちらのデバッガもポインタ越しのフィールドをこの形で読みます）。
      wrap.append(varRow(k, expr + '->' + k.name, depth + 1));
    }
    if (!(wrap.__kids || []).length) {
      wrap.append(Object.assign(el('div', 'empty small'),
                                { textContent: '（中身を読めませんでした）' }));
    }
  };
  return wrap;
}

function explainNoVars(text) {
  if (!text || !text.trim()) return 'デバッグしていません。';
  if (/no variable information|No symbol table info|No locals/i.test(text)) {
    return '変数の一覧が出せません。\n'
      + 'コンパイラが 0.27.0 以前か、最適化つきで建てています。\n'
      + '（変数のデバッグ情報は 0.28.0 から。デバッグ実行は -O0 です）';
  }
  return text;
}

/* ── 呼び出し履歴 ───────────────────────────── */
function showFrames(frames) {
  S.frames = frames || [];
  const box = $('frames');
  box.innerHTML = '';
  if (!S.frames.length) {
    box.append(Object.assign(el('div', 'empty small'), { textContent: 'デバッグしていません。' }));
    return;
  }
  for (const f of S.frames) {
    const row = el('div', 'frame' + (f.index === S.frameIndex ? ' current' : ''));
    row.append(el('span', 'nm', `#${f.index} ${f.func}`));
    if (f.file) row.append(el('span', 'fl', `${base(f.file)}:${f.line}`));
    // ★ 押すと、その枠の変数に切り替わります（呼び出した側の変数が見えます）。
    row.onclick = () => selectFrame(f.index);
    box.append(row);
  }
}

async function selectFrame(index) {
  if (S.mode !== 'dbg-pause') {
    const f = S.frames.find((x) => x.index === index);
    if (f) gotoLocation(f.file, f.line);
    return;
  }
  const view = await call(window.ide.debug.selectFrame, index);
  if (!view) return;
  applyFrameView(view);
}

// 枠を選んだあと（または止まった直後）の画面の作り直し
function applyFrameView(view) {
  S.frameIndex = view.frameIndex || 0;
  S.stopAt = { ...(S.stopAt || {}), file: view.file, line: view.line, column: view.column };
  showVars(view.vars, view.locals);
  $('frame-label').textContent = view.func ? `#${S.frameIndex} ${view.func}` : '';
  showFrames(S.frames);
  if (view.file) gotoLocation(view.file, view.line, view.column).then(() => {
    paintDecorations();
    paintInlineValues();
  });
}

/* ────────────────────────────────────────────────────────
   main からの知らせ
   ──────────────────────────────────────────────────────── */
function onAppEvent({ type, payload }) {
  switch (type) {
    case 'console':
      writeConsole(payload.stream, payload.text);
      break;

    case 'run:exit':
      setMode('idle');
      break;

    case 'debug:running':
      setMode('dbg-run');
      break;

    case 'debug:stopped': {
      setMode('dbg-pause');
      S.stopAt = payload;
      S.frames = payload.frames || [];
      S.frameIndex = payload.frameIndex || 0;
      showFrames(S.frames);
      showVars(payload.vars, payload.locals);
      $('frame-label').textContent = payload.func ? `#${S.frameIndex} ${payload.func}` : '';
      // ★ 止まった先が別のファイル（import した先・標準ライブラリ）でも、
      //   そのファイルを開いて、その行を出します。
      if (payload.file) {
        gotoLocation(payload.file, payload.line, payload.column).then(() => {
          paintDecorations();
          paintInlineValues();
        });
      } else {
        paintDecorations();
      }
      writeConsole('info', `⏸ ${base(payload.file || '')}:${payload.line}（${payload.reason}）\n`);
      break;
    }

    // 呼び出し履歴で別の枠を選んだとき（main 側から返ってくる形は同じ）
    case 'debug:frame':
      applyFrameView(payload);
      break;

    // ブレークポイントを置けたか（置けない＝その行が実行ファイルに無い）
    case 'debug:breakpoints':
      for (const b of payload || []) S.bpState.set(b.file + ':' + b.line, b.resolved);
      renderBreakpointList();
      paintDecorations();
      break;

    case 'debug:exited':
      setMode('idle');
      showFrames([]);
      showVars([], '');
      S.bpState.clear();
      renderBreakpointList();
      if (inlineValues) inlineValues.clear();
      break;

    case 'debug:log':
      if (payload && payload.trim()) writeConsole('build', payload.replace(/\n*$/, '\n'));
      break;

    case 'menu':
      onMenu(payload);
      break;
  }
}

function onMenu(cmd) {
  const map = {
    'open-folder': openFolder,
    'new-file': () => newEntry(false),
    'new-folder': () => newEntry(true),
    'save': () => S.active && saveFile(S.active),
    'save-all': saveAll,
    'close-tab': () => S.active && closeTab(S.active),
    'find': () => editor && editor.getAction('actions.find').run(),
    'check': doCheck,
    'run': doRun,
    'stop': doStop,
    'debug': doDebug,
    'debug-or-continue': debugOrContinue,
    'goto-definition': gotoDefinition,
    'go-back': goBack,
    'set-entry': () => {
      const p = currentYs();
      if (!p) { toast('.ys のファイルを開いてください。'); return; }
      setEntry(p);
      writeConsole('info', `入口を ${base(p)} にしました。実行・デバッグはこのファイルを建てます。\n`);
    },
    'clear-entry': () => {
      setEntry('');
      writeConsole('info', '入口の指定をやめました（開いている .ys を建てます）。\n');
    },
    'continue': () => dbg('resume'),
    'pause': doPause,
    'step-over': () => dbg('stepOver'),
    'step-into': () => dbg('stepInto'),
    'step-out': () => dbg('stepOut'),
    'toggle-breakpoint': () => S.active && toggleBreakpoint(S.active, editor.getPosition().lineNumber),
    'clear-breakpoints': clearBreakpoints,
    'font-bigger': () => setFontSize(S.settings.fontSize + 1),
    'font-smaller': () => setFontSize(S.settings.fontSize - 1),
    'toggle-theme': () => setTheme(S.settings.theme === 'dark' ? 'light' : 'dark'),
    'settings': openSettings,
  };
  if (map[cmd]) map[cmd]();
}

function setFontSize(n) {
  n = Math.min(28, Math.max(9, n));
  S.settings = { ...S.settings, fontSize: n };
  editor.updateOptions({ fontSize: n });
  window.ide.settings.set({ fontSize: n });
}

function setTheme(t) {
  S.settings = { ...S.settings, theme: t };
  document.body.dataset.theme = t;
  monacoRef.editor.setTheme(t === 'light' ? 'yashiro-light' : 'yashiro-dark');
  window.ide.settings.set({ theme: t });
}

/* ────────────────────────────────────────────────────────
   設定
   ──────────────────────────────────────────────────────── */
function wireSettings() {
  $('set-entry-here').onclick = () => {
    const p = currentYs();
    if (p) $('set-entry').value = p;
  };
  $('set-compiler-pick').onclick = async () => {
    const t = await call(window.ide.toolchain.pickCompiler);
    if (t) {
      $('set-compiler').value = t.compiler || '';
      S.tool = t;
      renderToolReport();
      refreshToolchain();
    }
  };
  $('settings-dialog').addEventListener('close', async (e) => {
    const dlg = $('settings-dialog');
    if (dlg.returnValue !== 'save') return;
    // ★ 入口はフォルダごとに覚えます（設定そのものには混ぜません）。
    setEntry($('set-entry').value.trim());
    const patch = {
      compilerPath: $('set-compiler').value.trim(),
      debuggerPath: $('set-debugger').value.trim(),
      optLevel: $('set-opt').value,
      extraArgs: $('set-extra').value,
      fontSize: Number($('set-font').value) || 14,
      autoSaveBeforeBuild: $('set-autosave').checked,
    };
    S.settings = await call(window.ide.settings.set, patch);
    editor.updateOptions({ fontSize: S.settings.fontSize });
    refreshToolchain();
  });
}

async function openSettings() {
  S.settings = await call(window.ide.settings.get);
  $('set-compiler').value = S.settings.compilerPath || '';
  $('set-debugger').value = S.settings.debuggerPath || '';
  $('set-opt').value = S.settings.optLevel || '-O0';
  $('set-entry').value = S.entry || '';
  $('set-extra').value = S.settings.extraArgs || '';
  $('set-font').value = S.settings.fontSize || 14;
  $('set-autosave').checked = !!S.settings.autoSaveBeforeBuild;
  await refreshToolchain();
  renderToolReport();
  $('settings-dialog').showModal();
}

function renderToolReport() {
  const t = S.tool || {};
  $('tool-report').textContent = [
    `コンパイラ : ${t.compiler || '見つかりません'}`,
    `版         : ${t.compilerVersion || '—'}`,
    `runtime.a  : ${t.runtime || '（コンパイラ自身が探します）'}`,
    `標準ライブラリ: ${t.libDir || '（コンパイラ自身が探します）'}`,
    `デバッガ   : ${t.debugger || '見つかりません'}`,
    `入口       : ${S.entry || '（開いている .ys）'}`,
    `clang      : ${t.hasClang ? 'あり' : 'ありません（リンクできません）'}`,
  ].join('\n');
}
