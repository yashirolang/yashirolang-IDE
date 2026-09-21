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

const sources = require('./sources');

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
    // 呼び出し履歴で 1 つ選ぶ（選んだ枠の変数が見えます）
    frameSelect: (n) => `frame select ${n}`,
    // ★ 参照型（list / クラス / rc）は番地が出るので、開くときに中身を読みます。
    deref: (expr) => `frame variable -- *${expr}`,
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
    // ⚠️ gdb の `info locals` に引数は出ません。`info args` と繋げて渡します。
    locals: 'info locals',
    argsList: 'info args',
    frameSelect: (n) => `frame ${n}`,
    deref: (expr) => `print *${expr}`,
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
  //   'stopped' … { file, line, column, reason, frames, locals, vars, frameIndex }
  //   'frame'   … 呼び出し履歴で別の枠を選んだ（中身は 'stopped' と同じ形）
  //   'breakpoints' … [{ file, line, resolved }]（置けたかどうか）
  //   'running' … 対象が動き出した
  //   'exited'  … { code }
  //   'error'   … 文字列
  constructor({ debuggerPath, kind, exe, cwd, source, args, sourceMap }, onEvent) {
    this.kind = kind;
    this.d = DIALECT[kind];
    if (!this.d) throw new Error(`対応していないデバッガです: ${kind}`);
    this.exe = exe;
    this.cwd = cwd;
    this.source = source;
    this.args = args || [];
    // ★ ファイル名 → 本当の場所。import した先や標準ライブラリで止まったとき、
    //   デバッガが言う短い名前（`strings.ys`）をここで開ける場所に直します。
    this.sourceMap = sourceMap || new Map();
    this.frameIndex = 0;
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

    // ★ ブレークポイントは**どのファイルにでも**置けます（import した先も
    //   標準ライブラリも）。置けたかどうかを 1 つずつ見て、画面へ返します。
    const placed = [];
    for (const bp of breakpoints || []) {
      placed.push(await this.addBreakpoint(bp.file, bp.line, { quiet: true }));
    }
    if (placed.length) this.onEvent('breakpoints', placed);
    return this._launch();
  }

  async _launch() {
    this.state = 'running';
    this.onEvent('running');
    // ⚠️ この await は「止まる／終わる」まで返りません。
    //   対象の番号（pid）は _onData が**流れてくる途中で**拾います
    //   （ここで拾っていたら、一時停止したい頃にはもう遅い）。
    const text = await this._send(this.d.launch(this.io, this.args));
    this._catchPid(text);
    return this._afterStop(text);
  }

  // 対象プログラムの番号を覚える。一時停止（SIGINT）の宛先になります。
  _catchPid(text) {
    if (this.inferiorPid) return;
    const m = String(text).match(this.d.pid);
    if (m) this.inferiorPid = Number(m[1]);
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
    this.frameIndex = 0;
    const frames = await this._send(this.d.backtrace);
    const view = await this._readFrame(text);

    const stop = {
      reason: pickReason(text),
      ...view,
      frames: parseFrames(frames, this.d, (f) => this._resolve(f)),
    };
    this.onEvent('stopped', stop);
    return { state: 'stopped', stop };
  }

  // いま選んでいる枠（既定は #0）の場所と変数を読む。
  //
  // ★ 呼び出し履歴の別の枠を選ぶと、**その枠の**変数が見えます
  //   （呼び出した側の変数を見たいときに要ります）。
  async _readFrame(fallbackText) {
    const where = await this._send(this.d.where);
    let locals = await this._send(this.d.locals);
    if (this.d.argsList) locals = (await this._send(this.d.argsList)) + '\n' + locals;

    const m = where.match(this.d.loc) || (fallbackText || '').match(this.d.loc);
    // 枠の見出し（`util.add(a=5, b=5) at util.ys:2`）から引数の名前を取ります。
    const argNames = parseArgNames(where);
    const vars = parseVars(locals, this.kind).map((v) => ({
      ...v,
      arg: argNames.includes(v.name),
    }));
    return {
      file: m ? this._resolve(m[1]) : null,
      line: m ? Number(m[2]) : null,
      column: m && m[3] ? Number(m[3]) : 1,
      func: functionName(where.split('\n').find((l) => this.d.loc.test(l)) || ''),
      frameIndex: this.frameIndex,
      locals: locals.trim(),
      // ★ A-35 から、変数は「名前・型・値」の並びで渡せます。
      //   ⚠️ 生の文字列（locals）も残します。解析が外れても、
      //     画面が何も出せなくなることはありません。
      vars,
    };
  }

  // 呼び出し履歴の枠を選び直す（画面で枠をクリックしたとき）。
  async selectFrame(index) {
    if (this.state !== 'stopped') return null;
    const n = Math.max(0, Number(index) || 0);
    await this._send(this.d.frameSelect(n));
    this.frameIndex = n;
    const view = await this._readFrame('');
    this.onEvent('frame', view);
    return view;
  }

  // デバッガは短い名前（`util.ys`）でしか言いません（DWARF に入っているのが
  // ファイル名だけだからです）。開ける場所に直します。
  //
  // ★ 探すのは「入口の隣 → deps → 標準ライブラリ → 開いているフォルダ」。
  //   これで **import した先**と**標準ライブラリの中**でも止まれます。
  _resolve(file) {
    if (!file) return null;
    return sources.resolveSource(this.sourceMap, file, { cwd: this.cwd, fallback: this.source });
  }

  _onData(text) {
    this.buffer += text;
    // ★ 走り出した合図（「Process 1234 launched」）は、
    //   コマンドの返事を待っている**最中に**流れてきます。ここで拾います。
    this._catchPid(this.buffer);
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

  // 走っている最中に割り込む（画面の ⏸）。
  //
  // 🤔 なぜ Ctrl-C でも「デバッガへ命令」でもないのか
  //   ① デバッガはパイプで動かしているので端末がありません。
  //      Ctrl-C の文字を流しても、ただの入力です。
  //   ② 走らせている最中のデバッガは、次の命令を読みません
  //      （`process continue` を実行中で、返事待ちだからです）。
  //   残るのは信号だけです。**対象プログラムへ** SIGINT を送ると、
  //   デバッガが「signal SIGINT で止まった」と報告してきて、
  //   走らせていたコマンドの返事として返り、いつもの 'stopped' になります。
  //
  // ⚠️ lldb 自身へ SIGINT を送っても**何も起きません**（試しました）。
  //   宛先は対象プログラムです。
  // ⚠️ 押すのが早すぎたとき（走り出す前）に送ってはいけません。
  //   デバッガは対象を**止めた状態で**起こしてから走らせます。その隙に
  //   信号を送ると、「SIGSTOP で止まった・行は分からない」という
  //   役に立たない止まり方になります。だから**本当に走り出すまで待って**
  //   から送ります（待っても走り出さなければ、できないと答えます）。
  async pause() {
    if (process.platform === 'win32') return false;   // 送る手段がありません

    // ★ 起動の途中（state は 'init'）に押されることもあります。そのときは
    //   「走り出したらすぐ止めて」という意味なので、走り出すまで待ちます。
    for (let i = 0; i < 30; i++) {
      if (!this.alive || this.state === 'exited' || this.state === 'stopped') return false;
      const found = this._findInferior();
      // ps の状態が 'T' のあいだは、まだ起こされただけで走っていません。
      if (found && found.stat && found.stat[0] !== 'T') {
        this.inferiorPid = found.pid;
        try {
          process.kill(found.pid, 'SIGINT');
          return true;
        } catch { /* もう終わっていた */ }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // gdb は SIGINT を自分で受けても対象を止めてくれます（最後の手）。
    if (this.kind === 'gdb' && this.child && this.child.pid) {
      try { process.kill(this.child.pid, 'SIGINT'); return true; } catch {}
    }
    return false;
  }

  // 対象プログラムの番号を、デバッガの子孫から探す。
  //
  // 🤔 なぜ出力から取らないのか
  //   lldb が「Process 1234 launched」と言うのは、**止まったあと**です
  //   （SetAsync(False) のため）。走っている最中には出てきません。
  //
  // 木の形（macOS）… lldb → debugserver → 対象
  //          （Linux の gdb は gdb → 対象）。どちらも下までたどります。
  // 返すのは { pid, stat }（stat は ps の状態。'T' は「止められている」）。
  _findInferior() {
    if (!this.child || !this.child.pid) return null;
    let out = '';
    try {
      out = execFileSync('ps', ['-o', 'pid=,ppid=,stat=,command=', '-ax'], { encoding: 'utf8' });
    } catch {
      return null;
    }
    const kids = new Map();
    const info = new Map();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      info.set(pid, { pid, stat: m[3], cmd: m[4] });
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(pid);
    }
    // ⚠️ 同じ実行ファイルを別に動かしていることもあるので、
    //   **このデバッガの子孫**だけを見ます。
    const stack = [[this.child.pid, 0]];
    while (stack.length) {
      const [pid, depth] = stack.pop();
      if (depth > 4) continue;
      for (const k of kids.get(pid) || []) {
        const it = info.get(k);
        if (it && it.cmd.split(' ')[0] === this.exe) return it;
        stack.push([k, depth + 1]);
      }
    }
    return null;
  }

  // ⚠️ 置く先はファイル**名**で指します。DWARF に入っているのが名前だけ
  //   （`DW_AT_comp_dir` が `.`）なので、絶対パスで指しても gdb では
  //   当たりません。名前がぶつかるときは main.js が先に注意を出します。
  async addBreakpoint(file, line, { quiet } = {}) {
    const t = await this._send(this.d.breakSet(file, line));
    if (!quiet) this.onEvent('log', t);
    // 「置けなかった」＝その名前の行が実行ファイルに入っていない
    // （import していない・コンパイルされていないファイル）。
    const missed = /no locations|not found|Make breakpoint pending/i.test(t);
    const status = { file, line, resolved: !missed, detail: t.trim().split('\n')[0] || '' };
    if (!quiet) this.onEvent('breakpoints', [status]);
    return status;
  }

  async clearBreakpoints() {
    await this._send(this.d.breakClearAll);
  }

  // 任意の式や変数を見る（画面の「評価」欄から）
  // 参照型の中身を 1 段開く（list / クラス / rc）。
  //
  // ⚠️ 止まっているときだけ意味があります。動いている間は読めません。
  async expand(expr) {
    if (this.state !== 'stopped') return [];
    const text = await this._send(this.d.deref(expr));
    return parseMembers(text);
  }

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

// ── 変数（A-35 で見えるようになりました）──────────────────
//
// ★ 言語側が `-g` で**変数の名前と型**を出すようになったので、
//   デバッガから中身が読めます（0.28.0 以降）。
//
//   lldb `frame variable`:   (int) total = 6
//                            (str) msg = 0x1000 "hello"
//                            (list[int]) xs = 0x6000
//   gdb  `info locals`:      total = 6
//
// ⚠️ 型が出ない（gdb）ときは名前と値だけを持ちます。画面は型が空でも出せます。
const VAR_LLDB = /^\((?<type>[^)]+)\)\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$/;
const VAR_GDB = /^(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$/;

// 「変数の情報が無い」という、デバッガごとの言い方。
const NO_VARS = /no variable information|No symbol table info|No locals/i;

function parseVars(text, kind) {
    const out = [];
    if (!text || NO_VARS.test(text)) return out;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('(lldb)')) continue;
        // ⚠️ 入れ子の中身（"  x = 4"）は、ここでは拾いません。
        //    開いたときに deref で読み直します（1 段ずつ）。
        if (/^[}\])]/.test(line)) continue;
        const m = kind === 'lldb' ? line.match(VAR_LLDB) : line.match(VAR_GDB);
        if (!m) continue;
        const type = (m.groups.type || '').trim();
        const value = m.groups.value.trim();
        out.push({
            name: m.groups.name,
            type,
            value,
            // ★ 開けるのは「番地が出ているもの」だけです（list / クラス / rc）。
            //   str は中身が文字列として出ているので、開く必要がありません。
            openable: isPointerValue(value) && type !== 'str',
        });
    }
    return out;
}

// 枠の見出しから引数の名前を拾う。
//   lldb: frame #0: 0x… app`util.add(a=5, b=5) at util.ys:2:1
//   gdb : #0  add (a=5, b=5) at util.ys:2
// ★ 「どれが引数か」はここでしか分かりません（lldb の `frame variable` は
//    引数とローカルを混ぜて出すため）。画面ではこれで並び順を分けます。
function parseArgNames(text) {
    const line = String(text || '').split(/\r?\n/).find((l) => /\(.*\)/.test(l)) || '';
    const open = line.indexOf('(');
    if (open < 0) return [];
    let depth = 0;
    let end = -1;
    for (let i = open; i < line.length; i++) {
        if (line[i] === '(') depth++;
        else if (line[i] === ')') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    if (end < 0) return [];
    const out = [];
    for (const part of line.slice(open + 1, end).split(',')) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(part);
        if (m) out.push(m[1]);
    }
    return out;
}

function isPointerValue(value) {
    return /^0x[0-9a-fA-F]+/.test(value) && !/^0x0\b/.test(value) &&
           !/^0x[0-9a-fA-F]+\s+"/.test(value);
}

// `p *xs` の出力から、中身（フィールド）を取り出す。
//
//   (list[int]) { data = 0x…, len = 3, cap = 4 }
//   (Point)  (x = 4, y = 2.5)
//
// ★ いちばん外側の括弧の中を、深さを見ながら「, か改行」で割ります。
function parseMembers(text) {
    const s = String(text || '');
    // デバッガは 2 つの形で中身を出します。
    //
    //   (list[int]) $0 = { data = 0x…, len = 3, cap = 4 }   ← 大きいとき
    //   (Point)  (x = 4, y = 2.5)                           ← 小さいとき
    //
    // ⚠️ 先頭の型（`(Point)`）を中身と間違えないこと。飛ばしてから探します。
    let open = '{';
    let start = s.indexOf('{');
    if (start < 0) {
        open = '(';
        const head = /^\s*\([^()]*\)\s*/.exec(s);
        start = s.indexOf('(', head ? head[0].length : 0);
    }
    if (start < 0) return [];
    const close = open === '{' ? '}' : ')';
    let depth = 0;
    let end = -1;
    for (let i = start; i < s.length; i++) {
        if (s[i] === open) depth++;
        else if (s[i] === close) {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    if (end < 0) end = s.length;
    const body = s.slice(start + 1, end);

    const parts = [];
    let depth2 = 0;
    let cur = '';
    for (const c of body) {
        if ('{(['.includes(c)) depth2++;
        if ('})]'.includes(c)) depth2--;
        if ((c === ',' || c === '\n') && depth2 === 0) {
            parts.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    parts.push(cur);

    const out = [];
    for (const part of parts) {
        const t = part.trim();
        if (!t) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const name = t.slice(0, eq).trim().replace(/^\([^)]*\)\s*/, '');
        const value = t.slice(eq + 1).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        out.push({ name, type: '', value, openable: isPointerValue(value) });
    }
    return out;
}

// lldb は「t`t.main at t.ys:3:1」「libsystem.dylib`write + 10」の形、
// gdb は「main () at t.ys:3」「0x... in write ()」の形で出します。
function functionName(rest) {
  let s = rest;
  // gdb の `frame` は `#0  add (a=5) at util.ys:2` の形で番号から始まります。
  s = s.replace(/^\s*\*?\s*#\d+\s+/, '');
  const tick = s.indexOf('`');
  if (tick !== -1) s = s.slice(tick + 1);
  s = s.replace(/^0x[0-9a-fA-F]+\s+in\s+/, '');
  s = s.split(/\s+at\s+/)[0];
  s = s.replace(/\s*\+\s*\d+$/, '');
  s = s.replace(/\s*\(.*$/, '');
  return s.trim() || rest.trim().slice(0, 60);
}

module.exports = { DebugSession };
