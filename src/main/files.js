// フォルダの読み込みとファイルの作成・保存。
//
// ⚠️ ここは「IDE が触ってよい場所」を決める門番でもあります。
//    画面（renderer）から来たパスは、開いているフォルダの中かどうかを
//    必ず確かめてから使います。
'use strict';

const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');

// 木に出さないもの（ビルドの中間物と版管理）
const HIDDEN = new Set(['.git', 'node_modules', '.ysbuild', '.DS_Store']);
// 開けるファイル（これ以外はテキストとして開くか確認する）
const TEXT_EXT = new Set([
  '.ys', '.md', '.txt', '.toml', '.json', '.lock', '.c', '.h', '.ll', '.s',
  '.yml', '.yaml', '.cfg', '.ini', '.sh', '.mk', '',
]);

const MAX_BYTES = 8 * 1024 * 1024; // 8MB を超えるファイルは開かない

function insideRoot(root, target) {
  if (!root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// フォルダを 1 段ずつ読む（開いた枝だけ読むので、大きな木でも重くなりません）
async function readDir(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (HIDDEN.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
    items.push({
      name: e.name,
      path: path.join(dir, e.name),
      dir: e.isDirectory(),
    });
  }
  // フォルダが先、あとは名前順
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'ja') : a.dir ? -1 : 1));
  return items;
}

async function readFile(p) {
  const st = await fs.stat(p);
  if (!st.isFile()) throw new Error('ファイルではありません');
  if (st.size > MAX_BYTES) throw new Error('ファイルが大きすぎます（8MB まで）');
  const ext = path.extname(p).toLowerCase();
  if (!TEXT_EXT.has(ext)) {
    // 拡張子で分からないものは、先頭に NUL があるかで判定します。
    const head = await fs.readFile(p);
    if (head.includes(0)) throw new Error('テキストファイルではありません');
    return head.toString('utf8');
  }
  return fs.readFile(p, 'utf8');
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
  return true;
}

async function createFile(dir, name) {
  const p = path.join(dir, name);
  if (fssync.existsSync(p)) throw new Error('同じ名前のファイルがすでにあります');
  await fs.mkdir(dir, { recursive: true });
  // .ys を新規で作ったときは、すぐ動く雛形を入れておきます（Arduino の setup/loop と同じ考え）。
  const seed = path.extname(name) === '.ys'
    ? 'def main() -> int:\n    print("hello")\n    return 0\n'
    : '';
  await fs.writeFile(p, seed, 'utf8');
  return p;
}

async function createFolder(dir, name) {
  const p = path.join(dir, name);
  if (fssync.existsSync(p)) throw new Error('同じ名前のフォルダがすでにあります');
  await fs.mkdir(p, { recursive: true });
  return p;
}

async function rename(oldPath, newName) {
  const p = path.join(path.dirname(oldPath), newName);
  if (fssync.existsSync(p)) throw new Error('同じ名前がすでにあります');
  await fs.rename(oldPath, p);
  return p;
}

// ★ 消すのは「ごみ箱へ」に寄せます（取り返しがつくように）。
//    shell.trashItem は main.js 側から渡します。
async function remove(p, trashItem) {
  await trashItem(p);
  return true;
}

module.exports = { readDir, readFile, writeFile, createFile, createFolder, rename, remove, insideRoot };
