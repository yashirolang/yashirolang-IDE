// 設定の保存と読み出し。
//
// 置き場所は Electron の userData（macOS なら
// ~/Library/Application Support/yashirolang-ide/settings.json）です。
// ★ 壊れた JSON が置かれていても起動できるように、読めなければ既定値に戻します。
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  compilerPath: '',      // 空なら自動で探す
  debuggerPath: '',      // 空なら lldb / gdb を自動で探す
  lastFolder: '',        // 次の起動で開き直すフォルダ
  // ★ フォルダごとの「入口のファイル」。複数ファイルのとき、
  //   util.ys を見ていても建てるのは main.ys、を覚えておくところです。
  //   { "/path/to/myapp": "/path/to/myapp/main.ys" }
  entries: {},
  fontSize: 14,
  theme: 'dark',         // 'dark' | 'light'
  optLevel: '-O0',
  extraArgs: '',         // コンパイラに足したい引数（空白区切り）
  autoSaveBeforeBuild: true,
};

let cache = null;
let file = null;

function settingsFile() {
  if (!file) file = path.join(app.getPath('userData'), 'settings.json');
  return file;
}

function load() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    Object.assign(cache, JSON.parse(raw));
  } catch {
    // 無い / 壊れている → 既定値のまま
  }
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  cache = next;
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('設定を保存できませんでした:', e.message);
  }
  return next;
}

module.exports = { load, save, DEFAULTS };
