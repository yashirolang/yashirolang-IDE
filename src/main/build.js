// 「確認（型検査だけ）」と「コンパイル（実行ファイルを作る）」。
//
// 出来上がった物は元のフォルダを汚さないように、
// ソースと同じ場所の .ysbuild/ にまとめます。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { compilerEnv, findCompiler } = require('./toolchain');
const diagnostics = require('./diagnostics');
const sources = require('./sources');

let running = null;   // いま走っているコンパイル（同時に 1 本だけ）

function buildDir(source) {
  const d = path.join(path.dirname(source), '.ysbuild');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function exePath(source) {
  const base = path.basename(source, path.extname(source));
  return path.join(buildDir(source), base + (process.platform === 'win32' ? '.exe' : ''));
}

// 設定の extraArgs を配列にする。"" で囲んだ空白は 1 つの引数として扱います。
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// コンパイラを 1 回走らせて、出力とエラーを全部集めて返す。
function invoke(compiler, args, cwd, onOutput) {
  return new Promise((resolve) => {
    const child = spawn(compiler, args, { cwd, env: compilerEnv(compiler) });
    running = child;
    let buf = '';
    const collect = (chunk) => {
      const text = chunk.toString();
      buf += text;
      if (onOutput) onOutput(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      running = null;
      resolve({ code: -1, output: buf + `\nコンパイラを起動できませんでした: ${e.message}\n` });
    });
    child.on('close', (code, signal) => {
      running = null;
      resolve({ code: signal ? -1 : code, output: buf, signal });
    });
  });
}

// ⚠️ **import した先のエラーは、相対パスで返ってきます**（`bad_util.ys:2:14`）。
//   そのままだと「問題」一覧から飛べないので、ここで絶対パスに直します。
//   基準はコンパイラを走らせた場所（入口ファイルのディレクトリ）です。
function absolutize(diags, cwd) {
  const map = sources.sourceMap([cwd], {});
  const fix = (d) => {
    if (!d || !d.file) return d;
    d.file = sources.resolveSource(map, d.file, { cwd });
    return d;
  };
  for (const d of diags) {
    fix(d);
    for (const det of d.details || []) fix(det);
  }
  return diags;
}

function baseArgs(settings, source) {
  const args = [];
  // import をソースのフォルダからも探せるようにする（ysm の deps も見る）
  const dir = path.dirname(source);
  args.push('-I', dir);
  const deps = path.join(dir, 'deps');
  if (fs.existsSync(deps)) args.push('-I', deps);
  return args;
}

// 型検査だけ（Arduino の「検証」にあたる）
async function check(settings, source, onOutput) {
  const compiler = findCompiler(settings.compilerPath);
  if (!compiler) return { ok: false, diagnostics: [], output: 'コンパイラ（yashirolang）が見つかりません。設定で場所を指定してください。\n' };

  const args = [...baseArgs(settings, source), '--check', ...splitArgs(settings.extraArgs), source];
  const cwd = path.dirname(source);
  const r = await invoke(compiler, args, cwd, onOutput);
  const diags = absolutize(diagnostics.parse(r.output), cwd);
  const ok = r.code === 0 && !diags.some((d) => d.severity === 'error');
  return { ok, diagnostics: diags, output: r.output, exe: null };
}

// 実行ファイルまで作る。debug=true のときは -g を足します。
async function compile(settings, source, { debug = false } = {}, onOutput) {
  const compiler = findCompiler(settings.compilerPath);
  if (!compiler) return { ok: false, diagnostics: [], output: 'コンパイラ（yashirolang）が見つかりません。設定で場所を指定してください。\n' };

  const out = exePath(source);
  const args = [...baseArgs(settings, source)];
  if (debug) args.push('-g');
  // デバッグのときは最適化を切ります（行が飛ばないように）。
  args.push(debug ? '-O0' : (settings.optLevel || '-O0'));
  args.push(...splitArgs(settings.extraArgs));
  args.push(source, '-o', out);

  const cwd = path.dirname(source);
  const r = await invoke(compiler, args, cwd, onOutput);
  const diags = absolutize(diagnostics.parse(r.output), cwd);
  const ok = r.code === 0 && fs.existsSync(out);
  return { ok, diagnostics: diags, output: r.output, exe: ok ? out : null };
}

function cancel() {
  if (running) {
    running.kill('SIGTERM');
    running = null;
    return true;
  }
  return false;
}

module.exports = { check, compile, cancel, exePath, buildDir };
