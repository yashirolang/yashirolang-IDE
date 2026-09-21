// ファイルの居場所を決める係。
//
// 🤔 なぜ 1 か所にまとめるのか
//   「import の先」「デバッガが言ってきたファイル」「定義へ移動の行き先」は、
//   ぜんぶ**同じ場所を同じ順で**探さないと辻褄が合いません。
//   探す順は処理系と同じです。
//
//     ① 入口ファイルのディレクトリ    （`main.ys` の隣）
//     ② -I で足した場所（設定の追加引数）と `deps/`（ysm が置く場所）
//     ③ 標準ライブラリ（`--print-lib-dir`）
//
// ⚠️ デバッガは短い名前（`util.ys`）しか言いません。DWARF に入っているのが
//   ファイル名だけ（`DW_AT_comp_dir` が `.`）だからです。だから
//   **名前 → 場所**の表をこちらで作っておいて、止まったときに引きます。
'use strict';

const fs = require('fs');
const path = require('path');

// 木を歩くときに入らない場所
const SKIP = new Set(['.git', 'node_modules', '.ysbuild', 'build', '.dSYM']);

// 設定の extraArgs から -I を拾う（build.js の splitArgs と同じ割り方）
function includeArgsFrom(extraArgs) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const parts = [];
  let m;
  while ((m = re.exec(extraArgs || ''))) parts.push(m[1] ?? m[2] ?? m[3]);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '-I' && parts[i + 1]) out.push(parts[++i]);
    else if (parts[i].startsWith('-I') && parts[i].length > 2) out.push(parts[i].slice(2));
  }
  return out;
}

// import と定義へ移動が探す場所。処理系と同じ順で返します。
//
//   entryDir … 入口ファイル（またはいま見ているファイル）のディレクトリ
//   root     … 画面で開いているフォルダ
//   libDir   … 標準ライブラリ（toolchain.detect().libDir）
function searchDirs({ entryDir, root, libDir, extraArgs }) {
  const out = [];
  const push = (d) => {
    if (!d) return;
    const abs = path.resolve(d);
    if (!out.includes(abs) && fs.existsSync(abs)) out.push(abs);
  };
  push(entryDir);
  if (entryDir) push(path.join(entryDir, 'deps'));
  if (root) {
    push(root);
    push(path.join(root, 'deps'));
  }
  for (const d of includeArgsFrom(extraArgs)) push(path.isAbsolute(d) ? d : path.join(entryDir || root || '.', d));
  push(libDir);
  return out;
}

// モジュール名（`toml.parser`）→ ファイル（`deps/toml/parser.ys`）
function moduleFile(mod, dirs) {
  const rel = mod.split('.').join(path.sep) + '.ys';
  for (const d of dirs) {
    const p = path.join(d, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── ファイル名 → 本当の場所 の表 ────────────────────────
//
// ⚠️ 大きな木でも止まらないように、見に行くファイルの数に上限を置きます。
function collect(dir, depth, budget, out, recursive) {
  if (depth > 8 || budget.n <= 0) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.n <= 0) return;
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) collect(p, depth + 1, budget, out, true);
      continue;
    }
    if (!e.name.endsWith('.ys')) continue;
    budget.n--;
    const key = e.name;
    if (!out.has(key)) out.set(key, []);
    const list = out.get(key);
    if (!list.includes(p)) list.push(p);
  }
}

// 名前（`util.ys`）→ 候補の並び。手前に書いてあるものほど優先します。
function sourceMap(dirs, { root } = {}) {
  const out = new Map();
  const budget = { n: 4000 };
  for (const d of dirs) {
    // 入口の隣と deps は下の階層まで、標準ライブラリは 1 段だけ見ます。
    collect(d, 0, budget, out, true);
  }
  if (root) collect(root, 0, budget, out, true);
  return out;
}

// デバッガが言ってきた名前を、本当のファイルに直す。
//
//   file … `util.ys`（短い名前）か、絶対パスのこともあります
function resolveSource(map, file, { cwd, fallback } = {}) {
  if (!file) return null;
  if (path.isAbsolute(file) && fs.existsSync(file)) return file;

  const name = path.basename(file);
  if (cwd) {
    const near = path.resolve(cwd, file);
    if (fs.existsSync(near)) return near;
  }
  const cands = map && map.get(name);
  if (cands && cands.length) {
    // cwd の下にあるものを優先（同じ名前が 2 か所にあるとき）
    if (cwd) {
      const inCwd = cands.find((p) => p.startsWith(path.resolve(cwd) + path.sep));
      if (inCwd) return inCwd;
    }
    return cands[0];
  }
  if (fallback && path.basename(fallback) === name) return fallback;
  return cwd ? path.resolve(cwd, file) : file;
}

// 同じ名前のファイルが 2 か所以上にあるか（デバッガは名前でしか区別できません）
function ambiguous(map, names) {
  const out = [];
  for (const n of names) {
    const c = map.get(path.basename(n));
    if (c && c.length > 1) out.push({ name: path.basename(n), where: c });
  }
  return out;
}

module.exports = { searchDirs, moduleFile, sourceMap, resolveSource, ambiguous, includeArgsFrom };
