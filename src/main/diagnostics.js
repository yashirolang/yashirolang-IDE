// コンパイラの出力を、画面で扱える形（配列）に直します。
//
// yashirolang の出力はこの形です。
//
//   error: 型が一致しません
//     --> /tmp/bad.ys:2:14
//      |
//    2 |     x: int = "a"
//      |              ^^^ 型 'str' の式
//      |
//   note: 変数 'x' は 'int' 型として宣言されています
//     --> /tmp/bad.ys:2:5
//      ...
//      = ヒント: 本言語には暗黙の型変換がありません（言語仕様 3.5）
//
// ★ note と「= ヒント」は、直前の error / warning にぶら下げます。
//    画面の「問題」一覧では 1 行 1 件に見せたいためです。
'use strict';

const HEAD = /^(error|warning|note)\s*:\s*(.*)$/;
const LOC = /^\s*-->\s*(.+?):(\d+):(\d+)\s*$/;
const HINT = /^\s*=\s*(.*)$/;
// 波線の下に書かれる補足（「^^^ 型 'str' の式」の右側）
const CARET = /^\s*\|\s*[\^~]+\s*(.+?)\s*$/;

function parse(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let cur = null;      // 組み立て中の error / warning
  let pending = null;  // 組み立て中の note（cur にぶら下げる）

  const flushNote = () => {
    if (pending && cur) cur.details.push(pending);
    pending = null;
  };

  for (const line of lines) {
    const head = line.match(HEAD);
    if (head) {
      const [, sev, message] = head;
      if (sev === 'note') {
        flushNote();
        pending = { kind: 'note', message, file: null, line: null, column: null };
      } else {
        flushNote();
        cur = {
          severity: sev,               // 'error' | 'warning'
          message,
          file: null, line: null, column: null,
          details: [],
          raw: [line],
        };
        out.push(cur);
      }
      continue;
    }

    if (!cur) continue;               // 見出しの前に来た行は捨てる
    cur.raw.push(line);

    const loc = line.match(LOC);
    if (loc) {
      const target = pending || cur;
      if (target.file === null) {
        target.file = loc[1];
        target.line = Number(loc[2]);
        target.column = Number(loc[3]);
      }
      continue;
    }

    const hint = line.match(HINT);
    if (hint && hint[1]) {
      // ヒントは note の中に出ることもありますが、
      // 読む人にとっては「そのエラーへの助言」なので error 側にまとめます。
      cur.details.push({ kind: 'hint', message: hint[1] });
      continue;
    }

    const caret = line.match(CARET);
    if (caret && caret[1]) {
      (pending || cur).label = caret[1];
      continue;
    }
  }
  flushNote();

  // 位置が取れなかったものも「問題」には出したいので、そのまま残します。
  return out;
}

// 「エラー 1 件、警告 0 件」のような一行を作る
function summarize(diags) {
  const e = diags.filter((d) => d.severity === 'error').length;
  const w = diags.filter((d) => d.severity === 'warning').length;
  if (!e && !w) return null;
  const parts = [];
  if (e) parts.push(`エラー ${e} 件`);
  if (w) parts.push(`警告 ${w} 件`);
  return parts.join('、');
}

module.exports = { parse, summarize };
