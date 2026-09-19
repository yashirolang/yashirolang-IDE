// デバッグ実行。lldb（macOS 既定）と gdb（Linux 既定）を、
// 対話モードのまま子プロセスとして動かします。
//
// 🤔 なぜ MI（機械向けインタフェース）を使わないのか
//   lldb-mi は macOS に入っていないことが多く、gdb の MI とも互換がありません。
//   「clang さえあれば動く」という言語側の方針に合わせて、
//   **どちらの環境にも最初から入っている CLI** を相手にしています。
//
// ⚠️ 落とし穴が 2 つあります。両方ここで回避しています。
//   ① lldb はパイプで起動すると非同期モードになり、`run` が
//      停止を待たずに返ってしまう → 最初に SetAsync(False) を送ります。
//   ② デバッグ対象がデバッガと同じ端末を掴むと、こちらが送った
//      コマンドの文字がプログラム側に食われます
//      → 対象の入出力を FIFO とファイルに逃がします。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const SENTINEL = '@@YS_DONE@@';

// ⚠️ 目印はコマンドの文字列に「そのままの形で」出てはいけません。
//    パイプで動かすとデバッガが入力をそのまま echo するので、
//    目印がコマンドの反響の側で先に見つかり、
//    **1 つ前の応答を読んでしまう**（返事が 1 つずれる）からです。
//    そこで、印字したときだけ繋がるように割って書きます。
const MARK_LLDB = 'script print("@@YS" "_DONE@@")';
const MARK_GDB = 'printf "@@YS%s_DONE@@\\n", ""';

// デバッガごとの方言をここにまとめます。
const DIALECT = {
  lldb: {
    init: () => [
      'settings set auto-confirm true',
      'settings set interpreter.echo-commands false',
      'script lldb.debugger.SetAsync(False)',
    ],
    target: (exe) => `target create ${q(exe)}`,
    done: MARK_LLDB,
    breakSet: (file, line) => `breakpoint set --file ${q(path.basename(file))} --line ${line}`,
    breakClearAll: 'breakpoint delete',
    launch: (io, args) =>
      `process launch -i ${q(io.stdin)} -o ${q(io.stdout)} -e ${q(io.stdout)}` +
      (args && args.length ? ` -- ${args.map(q).join(' ')}` : ''),
    cont: 'process continue',
    stepOver: 'thread step-over',
    stepInto: 'thread step-in',
    stepOut: 'thread step-out',
    where: 'frame info',
    backtrace: 'thread backtrace',
    locals: 'frame variable',
    kill: 'process kill',
    quit: 'quit',
    // frame #0: 0x0001 t`t.main at t.ys:3:1
    loc: /\bat\s+([^\s(]+?):(\d+)(?::(\d+))?\b/,
    frame: /^\s*(\*)?\s*frame #(\d+):\s*0x[0-9a-fA-F]+\s+(.*)$/,
    pid: /Process\s+(\d+)\s+launched/,
    exited: /Process\s+\d+\s+exited with status\s*=\s*(-?\d+)/,
  },
  gdb: {
    init: () => ['set confirm off', 'set pagination off', 'set print pretty on'],
    target: (exe) => `file ${q(exe)}`,
    done: MARK_GDB,
    breakSet: (file, line) => `break ${q(path.basename(file))}:${line}`,
    breakClearAll: 'delete breakpoints',
    launch: (io, args) =>
      `run ${(args || []).map(q).join(' ')} < ${q(io.stdin)} > ${q(io.stdout)} 2>&1`,
    cont: 'continue',
    stepOver: 'next',
    stepInto: 'step',
    stepOut: 'finish',
    where: 'frame',
    backtrace: 'backtrace',
    locals: 'info locals',
    kill: 'kill',
    quit: 'quit',
    // #0  main () at t.ys:3
    loc: /\bat\s+([^\s(]+?):(\d+)\b/,
    frame: /^\s*(\*)?\s*#(\d+)\s+(.*)$/,
    pid: /process\s+(\d+)/i,
    exited: /exited (?:normally|with code\s*(\d+))/,
  },
};

function q(s) {
  return `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
}

class DebugSession {
  // onEvent(type, payload):
  //   'log'     … デバッガ自身の出力（デバッグコンソール）
  //   'stdout'  … 対象プログラムの出力
  //   'stopped' … { file, line, column, reason, frames, locals }
  //   'running' … 対象が動き出した
  //   'exited'  … { code }
  //   'error'   … 文字列
  constructor({ debuggerPath, kind, exe, cwd, source, args }, onEvent) {
    this.kind = kind;
    this.d = DIALECT[kind];
    if (!this.d) throw new Error(`対応していないデバッガです: ${kind}`);
    this.exe = exe;
    this.cwd = cwd;
    this.source = source;
    this.args = args || [];
    this.onEvent = onEvent;
    this.debuggerPath = debuggerPath;

    this.queue = Promise.resolve();
    this.buffer = '';
    this.waiter = null;      // { resolve, text }
    this.alive = false;
    this.inferiorPid = null;
    this.state = 'init';     // 'init' | 'stopped' | 'running' | 'exited'
    this.io = null;
    this.stdinFd = null;
    this.tailOffset = 0;
    this.tailTimer = null;
  }

  // ── 対象プログラムの入出力を、デバッガの端末から切り離す ──
  _prepareIO() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ysdbg-'));
    const out = path.join(dir, 'stdout');
    fs.writeFileSync(out, '');
    let stdin = path.join(dir, 'stdin');
    if (process.platform === 'win32') {
      fs.writeFileSync(stdin, '');
    } else {
      try {
        execFileSync('mkfifo', [stdin]);
        // O_RDWR で開くと、読み手がいなくても書き込み側が止まりません。
        this.stdinFd = fs.openSync(stdin, fs.constants.O_RDWR);
      } catch {
        fs.writeFileSync(stdin, '');
        this.stdinFd = null;
      }
    }
    this.io = { dir, stdout: out, stdin };
    return this.io;
  }

  // 対象の出力ファイルを追いかけて、増えた分だけ画面に送る。
  _startTail() {
    const read = () => {
      try {
        const st = fs.statSync(this.io.stdout);
        if (st.size > this.tailOffset) {
          const fd = fs.openSync(this.io.stdout, 'r');
          const len = st.size - this.tailOffset;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, this.tailOffset);
          fs.closeSync(fd);
          this.tailOffset = st.size;
          this.onEvent('stdout', buf.toString('utf8'));
        }
      } catch {
        // まだ作られていない等。次の周回で拾います。
      }
    };
    this.tailTimer = setInterval(read, 80);
    this._flushTail = read;
  }

  async start(breakpoints) {
    const dbg = this.debuggerPath;
    this.child = spawn(dbg, [], { cwd: this.cwd, env: process.env });
    this.alive = true;

    this.child.stdout.on('data', (d) => this._onData(d.toString()));
    this.child.stderr.on('data', (d) => this._onData(d.toString()));
    this.child.on('error', (e) => {
      this.alive = false;
      this.onEvent('error', `デバッガを起動できませんでした: ${e.message}`);
    });
    this.child.on('close', () => {
      this.alive = false;
      this._cleanup();
      if (this.state !== 'exited') {
        this.state = 'exited';
        this.onEvent('exited', { code: null });
      }
    });

    this._prepareIO();
    this._startTail();

    for (const c of this.d.init(this.exe)) await this._send(c);
    await this._send(this.d.target(this.exe));
    for (const bp of breakpoints || []) {
      await this._send(this.d.breakSet(bp.file, bp.line));
    }
    return this._launch();
  }

  async _launch() {
    this.state = 'running';
    this.onEvent('running');
    const text = await this._send(this.d.launch(this.io, this.args));
    const pid = text.match(this.d.pid);
    if (pid) this.inferiorPid = Number(pid[1]);
    return this._afterStop(text);
  }

  // 止まった / 終わったを見分けて、画面に必要な物を揃えて渡す。
  async _afterStop(text) {
    if (this._flushTail) this._flushTail();

    const ex = text.match(this.d.exited);
    if (ex) {
      this.state = 'exited';
      this.onEvent('exited', { code: ex[1] !== undefined ? Number(ex[1]) : 0 });
      return { state: 'exited' };
    }
    if (!this.alive) return { state: 'exited' };

    this.state = 'stopped';
    const where = await this._send(this.d.where);
    const frames = await this._send(this.d.backtrace);
    const locals = await this._send(this.d.locals);

    const m = (where.match(this.d.loc) || text.match(this.d.loc));
    const stop = {
      reason: pickReason(text),
      file: m ? this._resolve(m[1]) : null,
      line: m ? Number(m[2]) : null,
      column: m && m[3] ? Number(m[3]) : 1,
      frames: parseFrames(frames, this.d, (f) => this._resolve(f)),
      locals: locals.trim(),
    };
    this.onEvent('stopped', stop);
    return { state: 'stopped', stop };
  }

  // デバッガは短い名前（t.ys）で返してくることがあるので、
  // 開いているフォルダ基準の絶対パスに直します。
  _resolve(file) {
    if (!file) return null;
    if (path.isAbsolute(file)) return file;
    const cand = path.resolve(this.cwd, file);
    if (fs.existsSync(cand)) return cand;
    if (this.source && path.basename(this.source) === path.basename(file)) return this.source;
    return cand;
  }

  _onData(text) {
    this.buffer += text;
    if (!this.waiter) return;
    const at = this.buffer.indexOf(SENTINEL);
    if (at === -1) return;
    const done = this.buffer.slice(0, at);
    this.buffer = this.buffer.slice(at + SENTINEL.length);
    const w = this.waiter;
    this.waiter = null;
    w.resolve(clean(done, w.cmd));
  }

  // コマンドを 1 つ送り、目印が返るまで待つ。必ず 1 本ずつ直列で流します。
  _send(cmd) {
    const run = () =>
      new Promise((resolve) => {
        if (!this.alive) return resolve('');
        this.waiter = { resolve, cmd };
        this.buffer = '';
        this.child.stdin.write(cmd + '\n' + this.d.done + '\n');
      });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async _resume(cmd) {
    if (this.state === 'exited' || !this.alive) return { state: 'exited' };
    this.state = 'running';
    this.onEvent('running');
    const text = await this._send(cmd);
    this.onEvent('log', text);
    return this._afterStop(text);
  }

  continue_() { return this._resume(this.d.cont); }
  stepOver() { return this._resume(this.d.stepOver); }
  stepInto() { return this._resume(this.d.stepInto); }
  stepOut() { return this._resume(this.d.stepOut); }

  // 走っている最中に割り込む。対象へ直接 SIGINT を送ります
  // （パイプ越しのデバッガには Ctrl-C を渡せないため）。
  pause() {
    if (this.inferiorPid && this.state === 'running') {
      try { process.kill(this.inferiorPid, 'SIGINT'); return true; } catch {}
    }
    return false;
  }

  async addBreakpoint(file, line) {
    const t = await this._send(this.d.breakSet(file, line));
    this.onEvent('log', t);
  }

  async clearBreakpoints() {
    await this._send(this.d.breakClearAll);
  }

  // 任意の式や変数を見る（画面の「評価」欄から）
  async evaluate(expr) {
    const cmd = this.kind === 'lldb' ? `expression -- ${expr}` : `print ${expr}`;
    return this._send(cmd);
  }

  writeStdin(data) {
    try {
      if (this.stdinFd !== null) {
        fs.writeSync(this.stdinFd, data);
        return true;
      }
    } catch {}
    return false;
  }

  async stop() {
    if (!this.alive) return;
    try {
      if (this.inferiorPid) {
        try { process.kill(this.inferiorPid, 'SIGKILL'); } catch {}
      }
      this.child.stdin.write(this.d.kill + '\n' + this.d.quit + '\n');
    } catch {}
    setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} }, 800);
  }

  _cleanup() {
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.tailTimer = null;
    try { if (this.stdinFd !== null) fs.closeSync(this.stdinFd); } catch {}
    this.stdinFd = null;
    try { if (this.io) fs.rmSync(this.io.dir, { recursive: true, force: true }); } catch {}
  }
}

// デバッガのプロンプトと、自分が送ったコマンドの反響を落とす
function clean(text, cmd) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\((?:lldb|gdb)\)\s?/, ''));
  // パイプで動かすと、送ったコマンドがそのまま 1 行目に返ってきます。
  while (lines.length && cmd && lines[0].trim() === cmd.trim()) lines.shift();
  return lines
    .filter((l) => !/^\(lldb\)\s*$/.test(l) && !/^\(gdb\)\s*$/.test(l))
    .filter((l) => !l.includes('SetAsync') && !l.includes(SENTINEL)
                && !/^script print\(/.test(l) && !/^printf "@@YS/.test(l)
                && !/^settings set /.test(l))
    .join('\n')
    .replace(/^\n+/, '');
}

function pickReason(text) {
  const m = text.match(/stop reason = ([^\n]+)/);
  if (m) return m[1].trim();
  if (/Breakpoint \d+,/.test(text)) return 'breakpoint';
  if (/signal SIG(\w+)/.test(text)) return RegExp.$1;
  return 'stop';
}

// バックトレースを {index, func, file, line} の配列に直す。
// ⚠️ 「* thread #1, queue = ...」のような見出し行を拾わないように、
//    frame の行だけを相手にします。
function parseFrames(text, d, resolve) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(d.frame);
    if (!m) continue;
    const rest = m[3];
    const loc = rest.match(d.loc);
    out.push({
      index: Number(m[2]),
      func: functionName(rest),
      file: loc ? resolve(loc[1]) : null,
      line: loc ? Number(loc[2]) : null,
      current: !!m[1],
    });
  }
  return out;
}

// lldb は「t`t.main at t.ys:3:1」「libsystem.dylib`write + 10」の形、
// gdb は「main () at t.ys:3」「0x... in write ()」の形で出します。
function functionName(rest) {
  let s = rest;
  const tick = s.indexOf('`');
  if (tick !== -1) s = s.slice(tick + 1);
  s = s.replace(/^0x[0-9a-fA-F]+\s+in\s+/, '');
  s = s.split(/\s+at\s+/)[0];
  s = s.replace(/\s*\+\s*\d+$/, '');
  s = s.replace(/\s*\(.*$/, '');
  return s.trim() || rest.trim().slice(0, 60);
}

module.exports = { DebugSession };
