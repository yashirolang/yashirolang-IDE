// 画面の全部。Arduino IDE と同じで「確認 → 実行」を最短で押せることを第一にしています。
'use strict';

/* ────────────────────────────────────────────────────────
   状態
   ──────────────────────────────────────────────────────── */
const S = {
  settings: null,
  root: '',                 // 開いているフォルダ
  tabs: new Map(),          // path -> { model, viewState, dirty }
  active: null,             // いま表示しているファイルのパス
  breakpoints: new Map(),   // path -> Set<line>
  mode: 'idle',             // idle | building | running | dbg-run | dbg-pause
  frames: [],
  expanded: new Set(),      // 開いている枝
};

let editor = null;
let monacoRef = null;
let decorations = null;     // ブレークポイントと現在行

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

  editor.onDidChangeCursorPosition((e) => {
    $('st-pos').textContent = `${e.position.lineNumber}:${e.position.column}`;
  });

  // 行番号の左をクリック → ブレークポイントの付け外し
  editor.onMouseDown((e) => {
    const T = monacoRef.editor.MouseTargetType;
    if (e.target.type === T.GUTTER_GLYPH_MARGIN && S.active) {
      toggleBreakpoint(S.active, e.target.position.lineNumber);
    }
  });

  editor.addCommand(monacoRef.KeyCode.F9, () => {
    if (S.active) toggleBreakpoint(S.active, editor.getPosition().lineNumber);
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

  // 自己点検（test/smoke.js）から画面の中を覗くための窓口。
  // ここから触れるのは画面の関数だけで、ファイルや OS には届きません。
  window.__ide = { S, get editor() { return editor; }, toggleBreakpoint, openFile, doCheck, doRun, doDebug, doStop, dbg };

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
async function openFile(p) {
  if (S.tabs.has(p)) return activateTab(p);
  const text = await call(window.ide.fs.read, p);
  if (text === null) return;
  const uri = monacoRef.Uri.file(p);
  const model = monacoRef.editor.getModel(uri)
    || monacoRef.editor.createModel(text, isYs(p) ? YS_LANGUAGE_ID : undefined, uri);
  model.onDidChangeContent(() => markDirty(p, true));
  S.tabs.set(p, { model, viewState: null, dirty: false });
  renderTabs();
  activateTab(p);
}

function activateTab(p) {
  const tab = S.tabs.get(p);
  if (!tab) return;
  if (S.active && S.tabs.has(S.active)) S.tabs.get(S.active).viewState = editor.saveViewState();
  S.active = p;
  editor.setModel(tab.model);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  editor.focus();
  $('editor-empty').style.display = 'none';
  $('st-file').textContent = p;
  renderTabs();
  paintDecorations();
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
    const tab = el('div', 'tab' + (p === S.active ? ' active' : '') + (t.dirty ? ' dirty' : ''));
    tab.title = p;
    tab.append(el('span', 'nm', base(p)));
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
  if (set.has(line)) set.delete(line);
  else {
    set.add(line);
    // デバッグ中なら、その場で足します。
    if (S.mode.startsWith('dbg')) window.ide.debug.addBreakpoint(p, line);
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

function renderBreakpointList() {
  const box = $('bplist');
  box.innerHTML = '';
  let n = 0;
  for (const [p, set] of S.breakpoints) {
    for (const line of [...set].sort((a, b) => a - b)) {
      n++;
      const row = el('div', 'bp');
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
  $('btn-continue').onclick = () => dbg('resume');
  $('btn-step-over').onclick = () => dbg('stepOver');
  $('btn-step-into').onclick = () => dbg('stepInto');
  $('btn-step-out').onclick = () => dbg('stepOut');
  $('btn-settings').onclick = openSettings;
}

// 「いまビルドすべきファイル」＝ 開いている .ys。
// .ys 以外を見ているときは、最後に触った .ys を使います。
let lastYs = null;
function targetFile() {
  if (isYs(S.active)) { lastYs = S.active; return S.active; }
  if (lastYs && S.tabs.has(lastYs)) return lastYs;
  for (const p of S.tabs.keys()) if (isYs(p)) return p;
  return null;
}

async function prepare() {
  const src = targetFile();
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
  if (S.mode === 'running') return;
  const src = await prepare();
  if (!src) return;
  setMode('building');
  const r = await call(window.ide.run.start, src);
  if (!r || !r.started) { setMode('idle'); if (r) showProblems(r.diagnostics); return; }
  showProblems(r.diagnostics);
  setMode('running');
}

async function doDebug() {
  if (S.mode.startsWith('dbg')) return;
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

async function dbg(cmd) {
  if (!S.mode.startsWith('dbg')) return;
  setMode('dbg-run');
  await call(window.ide.debug[cmd]);
}

/* ────────────────────────────────────────────────────────
   画面の状態（ボタンの有効・無効）
   ──────────────────────────────────────────────────────── */
function setMode(mode) {
  S.mode = mode;
  const dbgOn = mode === 'dbg-pause';
  const busy = mode === 'building';
  const live = mode === 'running' || mode.startsWith('dbg');

  $('btn-check').disabled = busy || live;
  $('btn-run').disabled = busy || live;
  $('btn-debug').disabled = busy || live;
  $('btn-stop').disabled = !(busy || live);
  for (const id of ['btn-continue', 'btn-step-over', 'btn-step-into', 'btn-step-out']) {
    $(id).disabled = !dbgOn;
  }
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
    paintDecorations();
  }
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

  $('eval-input').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const expr = e.target.value.trim();
    if (!expr) return;
    const out = await call(window.ide.debug.evaluate, expr);
    $('locals').textContent = `${expr}\n${out || ''}\n\n` + $('locals').textContent;
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

// エディタの中にも波線を出す
function applyMarkers(diags) {
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
  for (const model of monacoRef.editor.getModels()) {
    const p = model.uri.fsPath || model.uri.path;
    monacoRef.editor.setModelMarkers(model, 'yashirolang', byFile.get(p) || []);
  }
}

// いまの yashirolang は -g で **行の情報だけ** を出します（変数の DWARF はまだ）。
// デバッガの生のエラーをそのまま見せると戸惑うので、言い換えます。
function explainLocals(text) {
  if (!text || !text.trim()) return '（変数の情報はありません）';
  if (/no variable information|No symbol table info/i.test(text)) {
    return '変数の一覧は出せません。\n'
      + 'いまのコンパイラは -g で行の情報だけを出すため、\n'
      + 'デバッガから変数名を引けません。\n'
      + '値を見たいところでは print(str(x)) を挟んでください。';
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
    const row = el('div', 'frame' + (f.index === 0 ? ' current' : ''));
    row.append(el('span', 'nm', `#${f.index} ${f.func}`));
    if (f.file) row.append(el('span', 'fl', `${base(f.file)}:${f.line}`));
    row.onclick = () => gotoLocation(f.file, f.line);
    box.append(row);
  }
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
      showFrames(payload.frames);
      $('locals').textContent = explainLocals(payload.locals);
      if (payload.file) gotoLocation(payload.file, payload.line, payload.column).then(paintDecorations);
      else paintDecorations();
      writeConsole('info', `⏸ ${base(payload.file || '')}:${payload.line}（${payload.reason}）\n`);
      break;
    }

    case 'debug:exited':
      setMode('idle');
      showFrames([]);
      $('locals').textContent = '';
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
    'continue': () => dbg('resume'),
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
    `clang      : ${t.hasClang ? 'あり' : 'ありません（リンクできません）'}`,
  ].join('\n');
}
