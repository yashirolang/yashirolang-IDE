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

  // 設定の lastFolder を仮のフォルダに向けて、起動と同時に開かせます。
  // ★ ふだんの設定を壊さないよう、userData ごと別の場所にします。
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'),
    JSON.stringify({ lastFolder: dir, autoSaveBeforeBuild: true }, null, 2));

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
