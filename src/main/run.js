// 作った実行ファイルを、そのまま走らせる（デバッガを挟まない実行）。
//
// 標準入力も繋ぐので、input() を使うプログラムも画面から動かせます。
'use strict';

const { spawn } = require('child_process');
const path = require('path');

let child = null;

function isRunning() {
  return !!child;
}

// onEvent(type, payload) で画面に流す:
//   'stdout' / 'stderr' … 文字列
//   'exit'              … { code, signal }
function start(exe, cwd, args, onEvent) {
  if (child) throw new Error('すでに実行中です');
  child = spawn(exe, args || [], {
    cwd: cwd || path.dirname(exe),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const started = child;

  child.stdout.on('data', (d) => onEvent('stdout', d.toString()));
  child.stderr.on('data', (d) => onEvent('stderr', d.toString()));
  child.on('error', (e) => {
    if (child === started) child = null;
    onEvent('stderr', `実行できませんでした: ${e.message}\n`);
    onEvent('exit', { code: -1, signal: null });
  });
  child.on('close', (code, signal) => {
    if (child === started) child = null;
    onEvent('exit', { code, signal });
  });
  return { pid: child.pid };
}

function write(data) {
  if (child && child.stdin.writable) {
    child.stdin.write(data);
    return true;
  }
  return false;
}

function stop() {
  if (!child) return false;
  child.kill('SIGTERM');
  // 素直に止まらないときのために、少し待って止めます。
  const c = child;
  setTimeout(() => {
    try { if (c && !c.killed) c.kill('SIGKILL'); } catch {}
  }, 1500);
  return true;
}

module.exports = { start, write, stop, isRunning };
