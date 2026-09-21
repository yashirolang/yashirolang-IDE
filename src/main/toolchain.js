// コンパイラ（yashirolang）とデバッガ（lldb / gdb）を探して、
// 起動に必要な環境変数を組み立てます。
//
// 🤔 なぜ環境変数を組み立てるのか
//   yashirolang は runtime.a と標準ライブラリを
//     ① 環境変数 PLC_RUNTIME_O / PLC_LIB_DIR
//     ② ビルド時に埋め込んだ絶対パス
//     ③ 実行ファイルからの相対（<prefix>/lib/plc/...）
//   の順で探します。make install した物や配布物は ③ で自力で見つけられますが、
//   ソースの木を **移動した** ときは ② が外れて動かなくなります。
//   IDE からは ① を必ず渡して、どちらの置き方でも動くようにします。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// PATH から実行ファイルを探す（which / where の代わり）
function which(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name + EXE);
    if (isExecutable(p)) return p;
  }
  return null;
}

// IDE を置いた場所の近くにソースの木があるか見る。
//   .../yashirolang_org/yashirolang-IDE   ← ここ
//   .../yashirolang_org/yashirolang       ← 隣
function nearbyCandidates() {
  const here = path.resolve(__dirname, '..', '..');
  const out = [];
  for (const root of [path.dirname(here), path.dirname(path.dirname(here)), os.homedir()]) {
    out.push(path.join(root, 'yashirolang', 'build', 'yashirolang' + EXE));
    out.push(path.join(root, 'yashirolang', 'bin', 'yashirolang' + EXE));
  }
  return out;
}

function findCompiler(configured) {
  if (configured && isExecutable(configured)) return configured;
  const onPath = which('yashirolang');
  if (onPath) return onPath;
  for (const c of nearbyCandidates()) if (isExecutable(c)) return c;
  return null;
}

function findDebugger(configured) {
  if (configured && isExecutable(configured)) {
    return { path: configured, kind: path.basename(configured).includes('gdb') ? 'gdb' : 'lldb' };
  }
  // macOS は lldb、Linux は gdb が入っていることが多いので順番を変えます。
  const order = process.platform === 'darwin' ? ['lldb', 'gdb'] : ['gdb', 'lldb'];
  for (const name of order) {
    const p = which(name);
    if (p) return { path: p, kind: name };
  }
  return null;
}

// コンパイラの置かれ方から runtime.a と lib を割り出す。
// 見つからなければ null を返して、コンパイラ自身の探索に任せます。
function resolveRuntime(compiler) {
  const bin = path.dirname(compiler);           // .../build か .../bin
  const root = path.dirname(bin);               // ソースの木の根 か <prefix>
  const cands = [
    // ソースの木をそのまま使う場合
    { runtime: path.join(bin, 'runtime.a'), lib: path.join(root, 'lib') },
    // make install / 配布物を展開した場合
    { runtime: path.join(root, 'lib', 'plc', 'runtime.a'), lib: path.join(root, 'lib', 'plc', 'lib') },
  ];
  for (const c of cands) {
    if (fs.existsSync(c.runtime) && fs.existsSync(c.lib)) return c;
  }
  return null;
}

function compilerEnv(compiler) {
  const env = { ...process.env };
  const rt = resolveRuntime(compiler);
  if (rt) {
    env.PLC_RUNTIME_O = rt.runtime;
    env.PLC_LIB_DIR = rt.lib;
  }
  return env;
}

// 標準ライブラリの場所は、**処理系に訊くのがいちばん正しい**（`--print-lib-dir`）。
// 置き方から割り出す resolveRuntime は、訊けなかったときの控えです。
function libDirOf(compiler) {
  try {
    const out = execFileSync(compiler, ['--print-lib-dir'], {
      env: compilerEnv(compiler),
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // 古い処理系は --print-lib-dir を知りません。下で置き方から割り出します。
  }
  const rt = resolveRuntime(compiler);
  return rt ? rt.lib : null;
}

function versionOf(compiler) {
  try {
    return execFileSync(compiler, ['--version'], {
      env: compilerEnv(compiler),
      encoding: 'utf8',
      timeout: 5000,
    }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

// 画面の下に出す「いま何を使っているか」をまとめて返す。
function detect(settings) {
  const compiler = findCompiler(settings.compilerPath);
  const dbg = findDebugger(settings.debuggerPath);
  const rt = compiler ? resolveRuntime(compiler) : null;
  return {
    compiler,
    compilerVersion: compiler ? versionOf(compiler) : null,
    runtime: rt ? rt.runtime : null,
    libDir: compiler ? libDirOf(compiler) : null,
    debugger: dbg ? dbg.path : null,
    debuggerKind: dbg ? dbg.kind : null,
    hasClang: !!which('clang'),
  };
}

module.exports = { detect, findCompiler, findDebugger, compilerEnv, libDirOf, which, isExecutable };
