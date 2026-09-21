// 起動の自己点検。
//
//   npm run smoke
//
// 画面を実際に組み上げて、「開く → 確認 → 実行 → デバッグ」までを
// 人の代わりに押します。コンパイラが無い環境では、その先を飛ばします。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const GOOD = `def main() -> int:
    x: int = 1
    y: int = x + 2
    print(str(y))
    return 0
`;

const BAD = `def main() -> int:
    x: int = "もじ"
    return 0
`;

const ASK = `def main() -> int:
    s: str = input()
    print("hello " + s)
    return 0
`;

// ★ 変数の点検（A-35。言語 0.28.0 以降）。
//   ⚠️ 14 行目（print の行）で止めます。**行を動かしたら下の 14 も直して
//     ください。** 13 行目（p への代入）で止めると p はまだ空で、
//     デバッガが出すのはゴミです（それが正しい姿です）。
const VARS = `class Point:
    x: int
    y: int

    def init(mut self, x: int, y: int) -> None:
        self.x = x
        self.y = y

def main() -> int:
    n: int = 7
    msg: str = "hello"
    xs: list[int] = [1, 2, 3]
    p: Point = Point(4, 5)
    print(str(n))
    return 0
`;

// ★ 複数ファイル（A）。main.ys が util.ys を import します。
//   ⚠️ 行の位置を動かしたら、下の点検の行番号も直してください。
const MAIN = `import util

def main() -> int:
    x: int = 5
    y: int = util.twice(x)
    print(str(y))
    return 0
`;

const UTIL = `def add(a: int, b: int) -> int:
    s: int = a + b
    return s

def twice(x: int) -> int:
    return add(x, x)
`;

// ★ 標準ライブラリの中まで入れるか（ステップイン）。
//   ⚠️ 4 行目で止めて、そこから入ります。行を動かしたら下も直してください。
const LIBUSE = `import strings

def main() -> int:
    s: str = strings.strip("  hi  ")
    print(s)
    return 0
`;

// ★ import した先にエラーがある形（相対パスで返ってきます）。
const BADIMPORT = `import badlib

def main() -> int:
    print(str(badlib.add(1, 2)))
    return 0
`;

const BADLIB = `def add(a: int, b: int) -> int:
    s: int = "もじ"
    return a + b
`;

// ★ 一時停止（⏸）の点検に使う、すぐには終わらないプログラム。
//   ⚠️ 3 行目の while で回り続けます。割り込むとここで止まります。
const SPIN = `def main() -> int:
    i: int = 0
    while i < 100000000000:
        i = i + 1
    print(str(i))
    return 0
`;

module.exports = async function smoke(win, app) {
  const results = [];
  const ok = (name, pass, extra) => {
    results.push({ name, pass, extra });
    console.log(`${pass ? '  ✓' : '  ✗'} ${name}${extra ? '  … ' + extra : ''}`);
  };

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = async (code, ms = 30000, every = 150) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if (await js(code)) return true; } catch {}
      await new Promise((r) => setTimeout(r, every));
    }
    return false;
  };

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));

    console.log('\nyashirolang IDE 自己点検');
    console.log('─'.repeat(52));

    ok('Monaco が読み込めた', await wait('!!(window.monaco && window.__ide)', 20000));
    ok('エディタが出来た', await js('!!window.__ide.editor'));

    const dir = process.env.YSIDE_SMOKE_FOLDER;
    ok('フォルダが開けた', await wait(`window.__ide.S.root === ${JSON.stringify(dir)}`, 10000));
    ok('ファイルが木に並んだ', await wait("document.querySelectorAll('#tree .node').length >= 2", 10000));

    const good = path.join(dir, 'hello.ys');
    const bad = path.join(dir, 'bad.ys');

    await js(`window.__ide.openFile(${JSON.stringify(good)})`);
    ok('ファイルを開けた', await wait(`window.__ide.S.active === ${JSON.stringify(good)}`, 8000));

    const tool = await js("(async () => (await window.ide.toolchain.detect()).value)()");
    if (!tool || !tool.compiler) {
      ok('コンパイラが見つかった', false, 'この先は飛ばします');
      return finish(results, app);
    }
    ok('コンパイラが見つかった', true, tool.compilerVersion || tool.compiler);

    // ── 確認（型検査） ──
    await js('window.__ide.doCheck()');
    ok('確認が通った',
      await wait("window.__ide.S.mode === 'idle' && document.getElementById('console').textContent.includes('確認できました')", 60000));

    // ── わざと壊した方で、問題一覧に出るか ──
    await js(`window.__ide.openFile(${JSON.stringify(bad)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(bad)}`, 8000);
    await js('window.__ide.doCheck()');
    const gotProblem = await wait("document.querySelectorAll('#problems .prob.error').length > 0", 60000);
    ok('型の誤りが問題一覧に出た', gotProblem);
    if (gotProblem) {
      const where = await js("document.querySelector('#problems .prob.error .where').textContent");
      ok('行と桁が取れた', /bad\.ys:\d+:\d+/.test(where), where);
      const markers = await js("monaco.editor.getModelMarkers({}).length");
      ok('エディタに波線が出た', markers > 0, `${markers} 件`);
    }

    // ── 実行 ──
    await js(`window.__ide.openFile(${JSON.stringify(good)})`);
    await js("document.getElementById('console').textContent = ''");
    await js('window.__ide.doRun()');
    const ran = await wait("document.getElementById('console').textContent.includes('終了コード 0')", 90000);
    ok('実行できた', ran);
    ok('プログラムの出力が出た',
      await js("document.getElementById('console').textContent.includes('3')"));

    // ── 実行中のプログラムに文字を送る ──
    const ask = path.join(dir, 'ask.ys');
    await js(`window.__ide.openFile(${JSON.stringify(ask)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(ask)}`, 8000);
    await js("document.getElementById('console').textContent = ''");
    await js('window.__ide.doRun()');
    const waiting = await wait("window.__ide.S.mode === 'running'", 90000);
    if (waiting) {
      await js("(async () => { await window.ide.run.stdin('せかい\\n'); })()");
      ok('標準入力を送れた',
        await wait("document.getElementById('console').textContent.includes('hello せかい')", 30000));
      await wait("window.__ide.S.mode === 'idle'", 20000);
    } else {
      ok('標準入力を送れた', false, '実行まで届きませんでした');
    }

    // ── デバッグ実行 ──
    if (!tool.debugger) {
      ok('デバッガが見つかった', false, 'デバッグの点検は飛ばします');
      return finish(results, app);
    }
    ok('デバッガが見つかった', true, tool.debuggerKind);

    // ★ デバッグするのは「いま開いている .ys」なので、hello.ys に戻します。
    await js(`window.__ide.openFile(${JSON.stringify(good)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(good)}`, 8000);

    await js(`window.__ide.toggleBreakpoint(${JSON.stringify(good)}, 3)`);
    ok('ブレークポイントを置けた', await js("document.querySelectorAll('#bplist .bp').length === 1"));

    await js("document.getElementById('console').textContent = ''");
    await js('window.__ide.doDebug()');
    const stopped = await wait("window.__ide.S.mode === 'dbg-pause'", 120000);
    ok('ブレークポイントで止まった', stopped);
    if (stopped) {
      const at = await js('JSON.stringify(window.__ide.S.stopAt)');
      const stop = JSON.parse(at);
      ok('止まった行が合っている', stop.line === 3, `${path.basename(stop.file || '')}:${stop.line}`);
      ok('呼び出し履歴が出た', await js("document.querySelectorAll('#frames .frame').length > 0"));

      await js("window.__ide.dbg('stepOver')");
      const stepped = await wait("window.__ide.S.mode === 'dbg-pause' && window.__ide.S.stopAt.line === 4", 60000);
      ok('ステップオーバーで次の行へ進んだ', stepped);

      await js("window.__ide.dbg('resume')");
      const done = await wait("window.__ide.S.mode === 'idle'", 60000);
      ok('続行して最後まで走った', done);
      ok('デバッグ中もプログラムの出力が拾えた',
        await js("document.getElementById('console').textContent.includes('3')"));
    }

    // ── 変数（A-35。言語 0.28.0 以降）──
    //
    // ⚠️ 古いコンパイラでは変数が出ません。そのときは「出ない」と
    //   言うだけで、落としません（言語の版は IDE の責任ではないので）。
    const vars = path.join(dir, 'vars.ys');
    await js(`window.__ide.openFile(${JSON.stringify(vars)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(vars)}`, 8000);
    await js(`window.__ide.toggleBreakpoint(${JSON.stringify(vars)}, 14)`);
    await js('window.__ide.doDebug()');
    const stopped2 = await wait("window.__ide.S.mode === 'dbg-pause'", 120000);
    ok('変数の点検：ブレークポイントで止まった', stopped2);
    if (stopped2) {
      const names = JSON.parse(await js('JSON.stringify(window.__ide.S.vars.map(v => v.name))'));
      const hasAll = ['n', 'msg', 'xs', 'p'].every((x) => names.includes(x));
      ok('変数が名前で並んだ', hasAll, names.join(', '));
      if (hasAll) {
        const byName = JSON.parse(await js(
          'JSON.stringify(Object.fromEntries(window.__ide.S.vars.map(v => [v.name, v])))'));
        ok('int の値が出た', byName.n.value === '7', byName.n.value);
        ok('str の中身が出た', /hello/.test(byName.msg.value), byName.msg.value);
        ok('list は開けるようになっている', byName.xs.openable === true);
        ok('クラスは開けるようになっている', byName.p.openable === true);

        // ★ 実際に開いて、中身が読めるか
        // ⚠️ 窓口は { ok, value } を返します（画面側の call が外しています）。
        const kids = JSON.parse(await js(
          "(async () => JSON.stringify((await window.ide.debug.expand('p')).value))()"));
        const f = Object.fromEntries((kids || []).map((k) => [k.name, k.value]));
        ok('クラスの中身が読めた', f.x === '4' && f.y === '5', JSON.stringify(f));

        const kids2 = JSON.parse(await js(
          "(async () => JSON.stringify((await window.ide.debug.expand('xs')).value))()"));
        const g = Object.fromEntries((kids2 || []).map((k) => [k.name, k.value]));
        ok('list の中身が読めた（len）', g.len === '3', JSON.stringify(g));

        // ★ 画面にも並んでいるか（S だけでなく DOM を見ます）
        const rows = await js("document.querySelectorAll('#locals .var').length");
        ok('画面に変数の行が出た', rows >= 4, `${rows} 行`);
      } else {
        const why = await js("document.getElementById('locals').textContent");
        ok('変数が出ない理由が画面に出た', /0\.28\.0|最適化/.test(why), why.slice(0, 80));
      }
      // ★ 名前の上に出る「いまの値」（マウスを当てたとき）
      //   14 行目は `print(str(n))`。`n` は 8 桁目です。
      const hover = await js("(async () => await window.__ide.hoverAt(14, 15))()");
      ok('名前の上に値が出た', /n/.test(hover || '') && /7/.test(hover || ''), String(hover || '').slice(0, 60));

      // ★ 行の右の薄い値（マウスを当てなくても見えるもの）
      // ⚠️ 描き直しはファイルを開いたあとなので、出るまで待ちます。
      // ⚠️ 画面に絵が出ているかではなく、**印が付いているか**で見ます
      //   （窓が隠れていると Monaco は描かないことがあります）。
      const COUNT = "window.__ide.editor.getModel().getAllDecorations()"
        + ".filter(d => d.options.after && d.options.after.inlineClassName === 'ys-inline-value').length";
      const inline = await wait(COUNT + ' > 0', 20000);
      ok('行の右にも値が出た', inline, await js(
        COUNT + " + ' 行（画面に出ているのは ' + document.querySelectorAll('.ys-inline-value').length + '）'"));

      await js("window.__ide.dbg('resume')");
      await wait("window.__ide.S.mode === 'idle'", 60000);
    }
    // ── 複数ファイル：import した先で止まる・定義へ移動 ──
    //
    // ★ ここが「複数ファイルのデバッグ」の要です。
    //   ブレークポイントは util.ys に置き、建てるのは main.ys です。
    const mainYs = path.join(dir, 'main.ys');
    const utilYs = path.join(dir, 'util.ys');

    await js(`window.__ide.openFile(${JSON.stringify(mainYs)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(mainYs)}`, 8000);

    // 定義へ移動：main.ys の `util.twice` → util.ys の twice（5 行目）
    await js("window.__ide.editor.setPosition({ lineNumber: 5, column: 20 })");
    await js('window.__ide.gotoDefinition()');
    const jumped = await wait(
      `window.__ide.S.active === ${JSON.stringify(utilYs)} && window.__ide.editor.getPosition().lineNumber === 5`,
      30000);
    ok('定義へ移動で別のファイルへ飛んだ', jumped,
      await js('window.__ide.S.active + ":" + window.__ide.editor.getPosition().lineNumber'));

    // ★ ⌘＋クリック／ピークが通る道（Monaco 本体の「定義へ移動」）も試します。
    //   ここが通れば、行き先が別のファイルでもタブが開きます。
    await js(`window.__ide.openFile(${JSON.stringify(mainYs)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(mainYs)}`, 8000);
    await js("window.__ide.editor.setPosition({ lineNumber: 5, column: 20 })");
    // ★ ⌘＋クリックの道（位置を渡して飛ぶ）。
    //   ⚠️ Monaco の min ビルドには editor.action.revealDefinition が
    //     入っていないので、IDE 側の道だけを確かめます。
    await js(`window.__ide.openFile(${JSON.stringify(mainYs)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(mainYs)}`, 8000);
    await js('window.__ide.gotoDefinition({ lineNumber: 5, column: 20 })');
    ok('⌘＋クリックの道（位置を渡しても飛べた）',
      await wait(`window.__ide.S.active === ${JSON.stringify(utilYs)}`, 30000),
      await js('window.__ide.S.active'));

    // 戻る
    await js('window.__ide.goBack()');
    ok('戻るで元の場所へ帰った',
      await wait(`window.__ide.S.active === ${JSON.stringify(mainYs)}`, 10000));

    // 入口を main.ys に決めて、util.ys を開いたままデバッグします。
    await js(`window.__ide.setEntry(${JSON.stringify(mainYs)})`);
    await js(`window.__ide.openFile(${JSON.stringify(utilYs)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(utilYs)}`, 8000);
    ok('入口が main.ys になった',
      (await js('(async () => await window.__ide.targetFile())()')) === mainYs);

    await js(`window.__ide.S.breakpoints.clear()`);
    await js(`window.__ide.toggleBreakpoint(${JSON.stringify(utilYs)}, 2)`);
    await js("document.getElementById('console').textContent = ''");
    await js('window.__ide.doDebug()');
    const stopped3 = await wait("window.__ide.S.mode === 'dbg-pause'", 120000);
    ok('import した先（util.ys）で止まった', stopped3);
    if (stopped3) {
      const at = JSON.parse(await js('JSON.stringify(window.__ide.S.stopAt)'));
      ok('止まったファイルが util.ys だった', at.file === utilYs, `${path.basename(at.file || '')}:${at.line}`);
      ok('その行が開いた', (await js('window.__ide.S.active')) === utilYs);

      const names = JSON.parse(await js('JSON.stringify(window.__ide.S.vars.map(v => v.name))'));
      ok('引数が変数一覧に並んだ', names.includes('a') && names.includes('b'), names.join(', '));
      const isArg = await js("JSON.stringify(window.__ide.S.vars.filter(v => v.arg).map(v => v.name))");
      ok('引数として印が付いた', /"a"/.test(isArg) && /"b"/.test(isArg), isArg);

      // 呼び出し履歴：#2 は main.ys の中（呼んだ側）
      const frames = JSON.parse(await js('JSON.stringify(window.__ide.S.frames.map(f => f.file))'));
      ok('呼び出し履歴が複数のファイルにまたがった',
        frames.some((f) => f === utilYs) && frames.some((f) => f === mainYs),
        frames.map((f) => path.basename(f || '?')).join(' ← '));

      // 枠を選び直すと、その枠（main.main）の変数が見えます。
      const mainFrame = JSON.parse(await js(
        'JSON.stringify(window.__ide.S.frames.filter(f => f.file === ' + JSON.stringify(mainYs) + ')[0] || null)'));
      if (mainFrame) {
        await js(`window.__ide.selectFrame(${mainFrame.index})`);
        const switched = await wait(
          `window.__ide.S.frameIndex === ${mainFrame.index} && window.__ide.S.vars.some(v => v.name === 'x')`,
          30000);
        ok('呼び出し元の枠に切り替えて、その変数が見えた', switched,
          await js('JSON.stringify(window.__ide.S.vars.map(v => v.name))'));
        ok('その枠のファイルが開いた', (await js('window.__ide.S.active')) === mainYs);
      } else {
        ok('呼び出し元の枠に切り替えて、その変数が見えた', false, '枠が見つかりません');
      }

      await js("window.__ide.dbg('resume')");
      await wait("window.__ide.S.mode === 'idle'", 60000);
      ok('複数ファイルのまま最後まで走った',
        await js("document.getElementById('console').textContent.includes('10')"));
    }
    await js("window.__ide.setEntry('')");

    // ── 標準ライブラリ（読むだけで開ける）──
    const lib = await js("(async () => JSON.stringify((await window.ide.fs.library()).value))()");
    const groups = JSON.parse(lib || '[]');
    ok('標準ライブラリの場所が分かった', groups.length > 0,
      groups.map((g) => g.name + ' (' + (g.items || []).length + ')').join('、'));
    // ── import した先のエラーへ飛べるか ──
    //
    // ⚠️ コンパイラは import した先のエラーを**相対パス**で返します。
    //   絶対パスに直していないと、「問題」を押しても開けません。
    const badimport = path.join(dir, 'badimport.ys');
    const badlib = path.join(dir, 'badlib.ys');
    await js(`window.__ide.setEntry(${JSON.stringify(badimport)})`);
    await js(`window.__ide.openFile(${JSON.stringify(badimport)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(badimport)}`, 8000);
    await js('window.__ide.doCheck()');
    const gotImportProblem = await wait(
      "document.querySelectorAll('#problems .prob.error').length > 0", 60000);
    ok('import した先のエラーが問題一覧に出た', gotImportProblem);
    if (gotImportProblem) {
      await js("document.querySelector('#problems .prob.error').click()");
      ok('押すと、その先のファイルの行が開いた',
        await wait(`window.__ide.S.active === ${JSON.stringify(badlib)}`
                   + ' && window.__ide.editor.getPosition().lineNumber === 2', 20000),
        await js('window.__ide.S.active'));
      const marked = await wait(
        `monaco.editor.getModelMarkers({ resource: monaco.Uri.file(${JSON.stringify(badlib)}) }).length > 0`,
        20000);
      ok('その先のファイルにも波線が出た', marked, await js(
        `monaco.editor.getModelMarkers({ resource: monaco.Uri.file(${JSON.stringify(badlib)}) }).length + ' 件'`));
    }
    await js("window.__ide.setEntry('')");

    // ── 走っている最中の一時停止（⏸）──
    //
    // ★ ブレークポイントを置かずに走らせて、途中で割り込みます。
    //   デバッガはパイプで動いていて端末がないので、対象へ信号を送ります。
    const spin = path.join(dir, 'spin.ys');
    await js(`window.__ide.setEntry(${JSON.stringify(spin)})`);
    await js(`window.__ide.openFile(${JSON.stringify(spin)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(spin)}`, 8000);
    await js('window.__ide.S.breakpoints.clear()');
    await js("document.getElementById('console').textContent = ''");
    // ⚠️ ここは**待ってはいけません**。ブレークポイントが無いので、
    //   doDebug() の約束は「止まるか終わるまで」返りません。投げたら先へ進みます。
    await js('window.__ide.doDebug(); 0');
    const spinning = await wait("window.__ide.S.mode === 'dbg-run'", 120000);
    ok('ブレークポイント無しで走り出した', spinning);
    if (spinning) {
      ok('走っている間、ボタンが ⏸ になった',
        (await js("document.getElementById('btn-continue').textContent")) === '⏸'
        && (await js("document.getElementById('btn-continue').disabled")) === false);

      await js('window.__ide.doPause()');
      const paused = await wait("window.__ide.S.mode === 'dbg-pause'", 30000);
      ok('一時停止でその場に止まった', paused,
        paused ? await js("window.__ide.S.stopAt.reason + ' @' + window.__ide.S.stopAt.line") : '');
      if (paused) {
        ok('止まった場所がこのファイルだった',
          (await js('window.__ide.S.stopAt.file')) === spin);
        ok('途中までの変数が読めた',
          await js("window.__ide.S.vars.some(v => v.name === 'i' && Number(v.value) > 0)"),
          await js("JSON.stringify(window.__ide.S.vars.map(v => v.name + '=' + v.value))"));
        ok('止まったのでボタンが ⏵ に戻った',
          (await js("document.getElementById('btn-continue').textContent")) === '⏵');

        // 続けて走らせてから、もう一度止められるか
        // ⚠️ ここも待ってはいけません（続行の約束は「次に止まるまで」返りません）。
        await js("window.__ide.dbg('resume'); 0");
        const again = await wait("window.__ide.S.mode === 'dbg-run'", 30000);
        const sent = await js('(async () => String(await window.__ide.doPause()))()');
        ok('続行したあと、もう一度止められた',
          await wait("window.__ide.S.mode === 'dbg-pause'", 30000),
          `走り直し=${again} 送った=${sent} 状態=${await js('window.__ide.S.mode')}`);
      }
      await js('window.__ide.doStop()');
      await wait("window.__ide.S.mode === 'idle'", 30000);
    }
    await js("window.__ide.setEntry('')");

    // ── 標準ライブラリの中へステップインできるか ──
    //
    // ★ `import strings` の中で止まると、そのファイルは
    //   **開いているフォルダの外**です。読むだけのタブで開きます。
    const libuse = path.join(dir, 'libuse.ys');
    await js(`window.__ide.setEntry(${JSON.stringify(libuse)})`);
    await js(`window.__ide.openFile(${JSON.stringify(libuse)})`);
    await wait(`window.__ide.S.active === ${JSON.stringify(libuse)}`, 8000);
    await js('window.__ide.S.breakpoints.clear()');
    await js(`window.__ide.toggleBreakpoint(${JSON.stringify(libuse)}, 4)`);
    await js('window.__ide.doDebug()');
    const stopped4 = await wait("window.__ide.S.mode === 'dbg-pause'", 120000);
    ok('ライブラリを使う側で止まった', stopped4);
    if (stopped4) {
      await js("window.__ide.dbg('stepInto')");
      const inLib = await wait(
        "window.__ide.S.mode === 'dbg-pause' && /strings\\.ys$/.test(window.__ide.S.stopAt.file || '')",
        60000);
      ok('標準ライブラリの中へ入れた（ステップイン）', inLib,
        await js("window.__ide.S.stopAt.file + ':' + window.__ide.S.stopAt.line"));
      if (inLib) {
        // ⚠️ タブが出来るのは、止まった知らせのあと（ファイルを読むので）。待ちます。
        ok('その場所のファイルが読むだけで開いた',
          await wait('!!window.__ide.S.tabs.get(window.__ide.S.stopAt.file)'
                     + ' && window.__ide.S.tabs.get(window.__ide.S.stopAt.file).readonly === true',
                     20000));
      }
      await js('window.__ide.doStop()');
      await wait("window.__ide.S.mode === 'idle'", 30000);
    }
    await js("window.__ide.setEntry('')");

    if (groups.length) {
      const strings = (groups[0].items || []).find((i) => i.name === 'strings.ys');
      if (strings) {
        await js(`window.__ide.openFile(${JSON.stringify(strings.path)})`);
        const opened = await wait(
          `window.__ide.S.active === ${JSON.stringify(strings.path)}`, 10000);
        ok('標準ライブラリを開けた（読むだけ）', opened);
        ok('読み取り専用になっている',
          await js(`window.__ide.S.tabs.get(${JSON.stringify(strings.path)}).readonly === true`));
      }
    }
  } catch (e) {
    ok('点検が最後まで走った', false, e.message);
  }
  return finish(results, app);
};

function finish(results, app) {
  const bad = results.filter((r) => !r.pass);
  console.log('─'.repeat(52));
  console.log(`${results.length - bad.length} / ${results.length} 件が通りました。`);
  if (bad.length) console.log('通らなかったもの: ' + bad.map((b) => b.name).join('、'));
  app.exit(bad.length ? 1 : 0);
}

// ── npm run smoke から直に呼ばれたとき ──
// 仮のフォルダを作り、そこを開いた状態で Electron を起動します。
if (require.main === module) {
  const { spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yside-smoke-'));
  fs.writeFileSync(path.join(dir, 'hello.ys'), GOOD);
  fs.writeFileSync(path.join(dir, 'bad.ys'), BAD);
  fs.writeFileSync(path.join(dir, 'ask.ys'), ASK);
  fs.writeFileSync(path.join(dir, 'vars.ys'), VARS);
  fs.writeFileSync(path.join(dir, 'main.ys'), MAIN);
  fs.writeFileSync(path.join(dir, 'util.ys'), UTIL);
  fs.writeFileSync(path.join(dir, 'libuse.ys'), LIBUSE);
  fs.writeFileSync(path.join(dir, 'badimport.ys'), BADIMPORT);
  fs.writeFileSync(path.join(dir, 'badlib.ys'), BADLIB);
  fs.writeFileSync(path.join(dir, 'spin.ys'), SPIN);

  // 設定の lastFolder を仮のフォルダに向けて、起動と同時に開かせます。
  // ★ ふだんの設定を壊さないよう、userData ごと別の場所にします。
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  // ★ 試すコンパイラを指定できます（YS_COMPILER=/path/to/cc npm run smoke）。
  //   ⚠️ 指定しなければ、ふだんと同じ順（PATH → 隣のソースの木）で探します。
  const settings = { lastFolder: dir, autoSaveBeforeBuild: true };
  if (process.env.YS_COMPILER) settings.compilerPath = process.env.YS_COMPILER;
  fs.writeFileSync(path.join(userData, 'settings.json'),
    JSON.stringify(settings, null, 2));

  const electron = require('electron');
  const child = spawn(electron, [path.join(__dirname, '..'), '--user-data-dir=' + userData], {
    stdio: 'inherit',
    env: { ...process.env, YSIDE_SMOKE: '1', YSIDE_SMOKE_FOLDER: dir },
  });
  child.on('close', (code) => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(code || 0);
  });
}
