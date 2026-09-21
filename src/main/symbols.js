// 定義へ移動と、名前の上に出す説明。
//
// ★ 意味は自分で決めません。処理系の `--dump-tokens`（＝コンパイラ自身の
//   字句解析器の出力）に乗って、名前の表（ysindex.js）を作ります。
//   VS Code 拡張の言語サーバと**同じ表**なので、答えも同じになります。
//
// ⚠️ 解けない名前は**解けないままにします**。当てずっぽうで別の場所へ
//   飛ばすのは、飛ばさないより悪いからです（`f().g` の `g` など）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { FileIndex } = require('./ysindex');
const { compilerEnv, findCompiler } = require('./toolchain');
const sources = require('./sources');

// ファイル → { key, index }。key は「中身が変わったか」を見るための印です。
const cache = new Map();
const MAX_CACHE = 200;

function tokens(compiler, file, cwd) {
  return new Promise((resolve) => {
    execFile(compiler, ['--dump-tokens', file], {
      cwd: cwd || path.dirname(file),
      env: compilerEnv(compiler),
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      // ⚠️ 字句エラーでも、そこまでのトークンは使えます（stderr は捨てます）。
    }, (err, stdout) => resolve(stdout || ''));
  });
}

// 編集中の中身はディスクにありません。`--dump-tokens` は本物のファイルを
// 読むので、一時ファイルに書いて渡します。
// ★ 字句解析だけなので、**置き場所はどこでも結果が変わりません**
//   （import を解く `--check` と違うところです）。作業フォルダは汚しません。
function withText(file, text, fn) {
  if (text === undefined || text === null) return fn(file);
  let onDisk = null;
  try {
    onDisk = fs.readFileSync(file, 'utf8');
  } catch {
    onDisk = null;
  }
  if (onDisk === text) return fn(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ysidx-'));
  const tmp = path.join(dir, path.basename(file));
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    return Promise.resolve(fn(tmp)).finally(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });
  } catch {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return fn(file);
  }
}

function cacheKey(file, text) {
  if (text !== undefined && text !== null) return 'buf:' + text.length + ':' + hash(text);
  try {
    const st = fs.statSync(file);
    return 'disk:' + st.mtimeMs + ':' + st.size;
  } catch {
    return 'none';
  }
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// 1 ファイルぶんの名前の表。中身が変わっていなければ使い回します。
async function indexOf(settings, file, text) {
  const compiler = findCompiler(settings.compilerPath);
  if (!compiler) return null;
  const key = cacheKey(file, text);
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.index;

  let body = text;
  if (body === undefined || body === null) {
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }
  const dump = await withText(file, text, (target) => tokens(compiler, target, path.dirname(file)));
  const index = new FileIndex(file, body, dump);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(file, { key, index });
  return index;
}

function forget(file) {
  if (file) cache.delete(file);
  else cache.clear();
}

function where(file, d) {
  return { file, line: d.line, column: d.col, length: d.length, name: d.name, kind: d.kind };
}

// ── 定義へ移動 ─────────────────────────────────────────
//
// 返すのは { file, line, column } か null です。
async function definition(ctx, { file, text, line, character }) {
  const idx = await indexOf(ctx.settings, file, text);
  if (!idx) return null;
  const hit = idx.at(line, character);
  if (!hit) return null;
  const dirs = ctx.dirs(file);

  // `import strings` の上 → そのファイルの先頭へ
  if (hit.import) {
    const target = sources.moduleFile(hit.import.module, dirs);
    return target ? { file: target, line: 1, column: 1, name: hit.import.module, kind: 'module' } : null;
  }
  // 宣言そのものの上 → その場（行き先は自分）
  if (hit.decl) return where(file, hit.decl);

  const ref = hit.ref;
  const local = idx.resolve(ref);
  if (local) return where(file, local);

  // `mod.name` / `変数.フィールド`
  if (ref.member) return resolveMember(ctx, idx, ref, dirs, file);
  return null;
}

// `a.b` の b を解く。解けるのは 2 つだけ（それ以外は解きません）。
//   ① a が import したモジュール           → そのファイルのトップの b
//   ② a が「型の書いてある変数」で、その型がこの木の中のクラス
async function resolveMember(ctx, idx, ref, dirs, file) {
  if (!ref.base) return null;

  const im = idx.findImport(ref.base);
  if (im) {
    const target = sources.moduleFile(im.module, dirs);
    if (!target) return null;
    const other = await indexOf(ctx.settings, target);
    if (!other) return null;
    const d = other.topLevel(ref.name);
    return d ? where(target, d) : null;
  }

  const base = idx.resolve({ name: ref.base, scope: ref.scope, member: false });
  if (!base || !base.type) return null;
  const cls = base.type.replace(/^rc\[/, '').replace(/\]$/, '').replace(/\s*\|\s*None$/, '').trim();

  const local = idx.membersOf(cls).find((m) => m.name === ref.name);
  if (local) return where(file, local);

  if (cls.includes('.')) {
    const modName = cls.slice(0, cls.lastIndexOf('.'));
    const clsName = cls.slice(cls.lastIndexOf('.') + 1);
    const target = sources.moduleFile(modName, dirs);
    if (!target) return null;
    const other = await indexOf(ctx.settings, target);
    if (!other) return null;
    const m = other.membersOf(clsName).find((x) => x.name === ref.name);
    return m ? where(target, m) : null;
  }
  return null;
}

// ── 名前の上に出す説明（型・かたち）──────────────────
const KIND_JA = {
  var: 'ローカル変数', param: '引数', field: 'フィールド', func: '関数',
  method: 'メソッド', class: 'クラス', type: '型', module: 'モジュール',
};

function describe(d, idx) {
  const lines = [];
  if (d.kind === 'func' || d.kind === 'method') {
    lines.push('```python', (d.detail || '').replace(/:\s*$/, ''), '```');
  } else if (d.kind === 'class') {
    const mem = idx ? idx.membersOf(d.name) : [];
    const fields = mem.filter((m) => m.kind === 'field').map((m) => '    ' + m.name + ': ' + m.type);
    lines.push('```python', 'class ' + d.name + ':', ...(fields.length ? fields : ['    …']), '```');
  } else if (d.type) {
    lines.push('```python', d.name + ': ' + d.type, '```');
  } else {
    lines.push('```python', d.detail || d.name, '```');
  }
  const ja = KIND_JA[d.kind] || '';
  if (ja) lines.push('', ja + (d.container ? '（' + d.container + '）' : ''));
  return lines.join('\n');
}

async function hover(ctx, { file, text, line, character }) {
  const idx = await indexOf(ctx.settings, file, text);
  if (!idx) return null;
  const hit = idx.at(line, character);
  if (!hit) return null;
  const dirs = ctx.dirs(file);

  if (hit.import) {
    const target = sources.moduleFile(hit.import.module, dirs);
    return {
      markdown: '```python\nimport ' + hit.import.module + '\n```\n\nモジュール'
        + (target ? '（' + target + '）' : '（見つかりません）'),
      word: hit.import.module,
    };
  }
  if (hit.decl) return { markdown: describe(hit.decl, idx), word: hit.decl.name };

  const ref = hit.ref;
  const local = idx.resolve(ref);
  if (local) return { markdown: describe(local, idx), word: ref.name };

  if (ref.member) {
    const found = await resolveMember(ctx, idx, ref, dirs, file);
    if (!found) return { markdown: '', word: (ref.base ? ref.base + '.' : '') + ref.name };
    const other = await indexOf(ctx.settings, found.file);
    const d = other && (other.topLevel(found.name)
      || other.decls.find((x) => x.line === found.line && x.name === found.name));
    return {
      markdown: d ? describe(d, other) : '',
      word: (ref.base ? ref.base + '.' : '') + ref.name,
    };
  }
  return { markdown: '', word: ref.name };
}

// そのファイルのトップの名前（クラス・関数）を並べる。
async function outline(ctx, { file, text }) {
  const idx = await indexOf(ctx.settings, file, text);
  if (!idx) return [];
  return idx.decls
    .filter((d) => d.kind !== 'param' && d.kind !== 'var')
    .map((d) => ({ name: d.name, kind: d.kind, line: d.line, column: d.col, type: d.type }));
}

module.exports = { definition, hover, outline, indexOf, forget };
