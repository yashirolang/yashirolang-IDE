// メニューバー。押されたら画面側に合図（menu イベント）を送るだけにして、
// 実際の処理はツールバーのボタンと同じ道を通します。
'use strict';

const { shell } = require('electron');

const isMac = process.platform === 'darwin';

module.exports = function buildMenu({ send, openDevTools }) {
  const item = (label, cmd, accelerator) => ({ label, accelerator, click: () => send(cmd) });

  return require('electron').Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'ファイル',
      submenu: [
        item('フォルダを開く…', 'open-folder', 'CmdOrCtrl+O'),
        item('新しいファイル…', 'new-file', 'CmdOrCtrl+N'),
        item('新しいフォルダ…', 'new-folder', 'CmdOrCtrl+Shift+N'),
        { type: 'separator' },
        item('保存', 'save', 'CmdOrCtrl+S'),
        item('すべて保存', 'save-all', 'CmdOrCtrl+Alt+S'),
        { type: 'separator' },
        item('タブを閉じる', 'close-tab', 'CmdOrCtrl+W'),
        { type: 'separator' },
        item('設定…', 'settings', 'CmdOrCtrl+,'),
        isMac ? { role: 'close', label: 'ウインドウを閉じる' } : { role: 'quit', label: '終了' },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '取り消す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべて選択' },
        { type: 'separator' },
        item('検索…', 'find', 'CmdOrCtrl+F'),
        { type: 'separator' },
        // ★ 定義へ移動は「見る」ではなく「編集」の隣に置きます
        //   （VS Code / Xcode と同じ F12）。
        item('定義へ移動', 'goto-definition', 'F12'),
        item('戻る', 'go-back', 'Alt+Left'),
      ],
    },
    {
      label: 'スケッチ',
      submenu: [
        item('確認（型検査）', 'check', 'CmdOrCtrl+R'),
        item('実行', 'run', 'CmdOrCtrl+Return'),
        item('停止', 'stop', 'CmdOrCtrl+.'),
        { type: 'separator' },
        // ★ 複数ファイルのときに「どれを建てるか」を決めるところ。
        item('このファイルを入口にする', 'set-entry'),
        item('入口の指定をやめる', 'clear-entry'),
      ],
    },
    {
      label: 'デバッグ',
      submenu: [
        // ★ F5 は VS Code と同じで「始める／続ける」の 1 つです。
        //   止まっているときに押すと続行になります。
        item('デバッグ実行 / 続行', 'debug-or-continue', 'F5'),
        item('続行', 'continue', 'F8'),
        // ★ 走っている最中に割り込みます（VS Code と同じ F6）。
        item('一時停止', 'pause', 'F6'),
        item('デバッグを止める', 'stop', 'Shift+F5'),
        { type: 'separator' },
        item('ステップオーバー', 'step-over', 'F10'),
        item('ステップイン', 'step-into', 'F11'),
        item('ステップアウト', 'step-out', 'Shift+F11'),
        { type: 'separator' },
        item('ブレークポイントを切り替え', 'toggle-breakpoint', 'F9'),
        item('ブレークポイントを全部消す', 'clear-breakpoints'),
      ],
    },
    {
      label: '表示',
      submenu: [
        item('文字を大きく', 'font-bigger', 'CmdOrCtrl+Plus'),
        item('文字を小さく', 'font-smaller', 'CmdOrCtrl+-'),
        item('明暗を切り替え', 'toggle-theme'),
        { type: 'separator' },
        { role: 'reload', label: '再読み込み' },
        { label: '開発者ツール', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: openDevTools },
        { role: 'togglefullscreen', label: 'フルスクリーン' },
      ],
    },
    {
      label: 'ヘルプ',
      submenu: [
        { label: 'yashirolang のドキュメント', click: () => shell.openExternal('https://github.com/yashirolang/yashirolang') },
        { label: 'IDE のリポジトリ', click: () => shell.openExternal('https://github.com/yashirolang/yashirolang-IDE') },
      ],
    },
  ]);
};
