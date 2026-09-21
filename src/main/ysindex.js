// ysindex.js — トークン列から「名前の表」を作る（定義へ移動・型の表示に使います）
//
// ★ **これは yashirolang-vscode の server/index.js と同じものです。**
//   （向こうを直したら、こちらへも同じ差分を持ってきてください。
//     エディタに依存しない書き方のまま、1 文字も変えずに置いています。）
//
//
// ★ **構文解析器は書きません。** 処理系の `--dump-tokens` が出す
//   トークン列（＝コンパイラ自身の字句解析器の出力）に乗ります。
//   自前で書き直すと、言語が変わったときに黙って食い違うためです。
//
// 🤔 トークンだけで名前が解けるのか
//   この言語の 2 つの規則のおかげで解けます。
//
//     ① **型注釈は必須**（`x: int = 1`）→ 宣言の行に型が書いてあります
//     ② **シャドーイング禁止**（言語仕様 5.1）→ 同じ関数の中で
//        同じ名前が 2 つの別物を指すことがありません
//
//   ⚠️ ただし**式の型は分かりません**。`f().g` の `g` のように、
//     型推論が要るものは**解きません**（当てずっぽうで飛ばすより、
//     飛ばさないほうが良いからです）。
//
// → 処理系が `--emit-index`（言語側 A-36 の提案）を出すようになれば、
//   ここは「JSON を読むだけ」になります。
'use strict';

// ★ `  12  IDENT     3:5    total` の形。位置と中身のあいだは空白の並びです。
//   ⚠️ 空白を 1 つしか食べないと、中身に空白が付いたままになります
//     （`   import` が `import` と一致しなくなり、宣言が 1 つも見つかりません）。
const TOKEN = /^\s*(\d+)\s+([A-Z]+)\s+(\d+):(\d+)\s*(.*)$/;

const KIND = {
    module: 2, class: 5, method: 6, func: 12, field: 8, var: 13, param: 13,
    type: 26,
};

function parseTokens(dump) {
    const toks = [];
    for (const line of String(dump || '').split('\n')) {
        const m = TOKEN.exec(line);
        if (!m) continue;
        toks.push({
            kind: m[2],
            line: parseInt(m[3], 10),
            col: parseInt(m[4], 10),
            text: m[5],
        });
    }
    return toks;
}

// 宣言 1 つ
function decl(name, kind, tok, extra) {
    return Object.assign({
        name,
        kind,
        line: tok.line,
        col: tok.col,
        length: name.length,
        type: '',
        detail: '',
        container: '',
        scope: 0,
    }, extra || {});
}

class FileIndex {
    constructor(uri, text, dump) {
        this.uri = uri;
        this.lines = String(text || '').split('\n');
        this.tokens = parseTokens(dump);
        this.decls = [];
        this.refs = [];
        this.imports = [];
        this.scopes = [{ id: 0, parent: -1, kind: 'module', name: '', depth: 0 }];
        this.build();
    }

    lineText(n) {
        return this.lines[n - 1] !== undefined ? this.lines[n - 1] : '';
    }

    newScope(kind, name, depth, parent) {
        const s = { id: this.scopes.length, parent, kind, name, depth };
        this.scopes.push(s);
        return s;
    }

    // ── 表を作る ──────────────────────────────────────────
    build() {
        const t = this.tokens;
        let depth = 0;                       // いまのインデントの深さ
        let stack = [this.scopes[0]];        // 効いているスコープ（module → class → func）
        let pending = null;                  // 次の INDENT で開くスコープ
        let stmtStart = true;                // 行（文）の先頭か
        const cls = () => {
            for (let i = stack.length - 1; i >= 0; i--)
                if (stack[i].kind === 'class') return stack[i];
            return null;
        };
        const here = () => stack[stack.length - 1];

        for (let i = 0; i < t.length; i++) {
            const tk = t[i];

            if (tk.kind === 'INDENT') {
                depth++;
                if (pending) {
                    pending.depth = depth;
                    stack.push(pending);
                    pending = null;
                }
                stmtStart = true;
                continue;
            }
            if (tk.kind === 'DEDENT') {
                depth--;
                while (stack.length > 1 && here().depth > depth) stack.pop();
                stmtStart = true;
                continue;
            }
            if (tk.kind === 'NEWLINE') {
                stmtStart = true;
                continue;
            }
            if (tk.kind === 'EOF') break;

            const atStart = stmtStart;
            stmtStart = false;

            // ── import a.b ──
            if (tk.kind === 'KEYWORD' && tk.text === 'import') {
                let j = i + 1;
                const parts = [];
                while (j < t.length && (t[j].kind === 'IDENT' ||
                       (t[j].kind === 'PUNCT' && t[j].text === '.'))) {
                    if (t[j].kind === 'IDENT') parts.push(t[j].text);
                    j++;
                }
                if (parts.length) {
                    this.imports.push({
                        module: parts.join('.'),
                        head: parts[0],
                        line: t[i + 1].line,
                        col: t[i + 1].col,
                        length: parts.join('.').length,
                    });
                }
                i = j - 1;
                continue;
            }

            // ── def NAME(...) ──
            if (tk.kind === 'KEYWORD' && tk.text === 'def') {
                const nameTok = t[i + 1];
                if (!nameTok || nameTok.kind !== 'IDENT') continue;
                const owner = cls();
                const d = decl(nameTok.text, owner ? 'method' : 'func', nameTok, {
                    container: owner ? owner.name : '',
                    detail: this.lineText(nameTok.line).trim(),
                    scope: here().id,
                });
                this.decls.push(d);
                const fnScope = this.newScope('func', nameTok.text, depth + 1,
                                              here().id);
                pending = fnScope;
                // 仮引数（`(` から `)` まで）
                i = this.readParams(i + 2, fnScope, d);
                continue;
            }

            // ── class NAME: ──
            if (tk.kind === 'KEYWORD' && tk.text === 'class') {
                const nameTok = t[i + 1];
                if (!nameTok || nameTok.kind !== 'IDENT') continue;
                this.decls.push(decl(nameTok.text, 'class', nameTok, {
                    detail: this.lineText(nameTok.line).trim(),
                    scope: here().id,
                }));
                pending = this.newScope('class', nameTok.text, depth + 1, here().id);
                i++;
                continue;
            }

            // ── interface NAME: ──（クラスと同じ扱い）
            if (tk.kind === 'KEYWORD' && tk.text === 'interface') {
                const nameTok = t[i + 1];
                if (!nameTok || nameTok.kind !== 'IDENT') continue;
                this.decls.push(decl(nameTok.text, 'class', nameTok, {
                    detail: this.lineText(nameTok.line).trim(),
                    scope: here().id,
                }));
                pending = this.newScope('class', nameTok.text, depth + 1, here().id);
                i++;
                continue;
            }

            // ── type NAME = int range(...) ──
            //   ⚠️ `type` は**予約語ではありません**（文脈で決まる語なので、
            //     トークンの種類は IDENT です）。形で見分けます。
            if (tk.kind === 'IDENT' && tk.text === 'type' && atStart &&
                t[i + 1] && t[i + 1].kind === 'IDENT' &&
                t[i + 2] && t[i + 2].kind === 'PUNCT' && t[i + 2].text === '=') {
                const nameTok = t[i + 1];
                if (nameTok && nameTok.kind === 'IDENT') {
                    this.decls.push(decl(nameTok.text, 'type', nameTok, {
                        detail: this.lineText(nameTok.line).trim(),
                        scope: here().id,
                    }));
                    i++;
                }
                continue;
            }

            // ── for IDENT in … ──
            if (tk.kind === 'KEYWORD' && tk.text === 'for') {
                let j = i + 1;
                while (j < t.length && !(t[j].kind === 'KEYWORD' && t[j].text === 'in')) {
                    if (t[j].kind === 'IDENT') {
                        this.decls.push(decl(t[j].text, 'var', t[j], {
                            type: '',
                            detail: this.lineText(t[j].line).trim(),
                            scope: here().id,
                        }));
                    }
                    j++;
                }
                i = j;
                continue;
            }

            // ── except E as IDENT: ──
            if (tk.kind === 'KEYWORD' && tk.text === 'except') {
                let j = i + 1;
                while (j < t.length && t[j].kind !== 'NEWLINE') {
                    if (t[j].kind === 'KEYWORD' && t[j].text === 'as' &&
                        t[j + 1] && t[j + 1].kind === 'IDENT') {
                        this.decls.push(decl(t[j + 1].text, 'var', t[j + 1], {
                            type: t[j - 1] ? t[j - 1].text : '',
                            detail: this.lineText(t[j + 1].line).trim(),
                            scope: here().id,
                        }));
                    }
                    j++;
                }
                continue;
            }

            // ── 変数・フィールドの宣言（IDENT : 型 [= 式]）──
            //   ★ 型注釈が必須なので、宣言は必ずこの形になります。
            if (atStart && tk.kind === 'IDENT' && t[i + 1] &&
                t[i + 1].kind === 'PUNCT' && t[i + 1].text === ':') {
                const typeToks = [];
                let j = i + 2;
                while (j < t.length && t[j].kind !== 'NEWLINE' &&
                       !(t[j].kind === 'PUNCT' && t[j].text === '=')) {
                    typeToks.push(t[j].text);
                    j++;
                }
                const inClass = here().kind === 'class';
                this.decls.push(decl(tk.text, inClass ? 'field' : 'var', tk, {
                    type: joinType(typeToks),
                    container: inClass ? here().name : '',
                    detail: this.lineText(tk.line).trim(),
                    scope: here().id,
                }));
                // ⚠️ 型の名前（`list[Token]` の Token）も**参照**です。
                //   ここを拾っておくと、型名から定義へ飛べます。
                for (let k = i + 2; k < j; k++)
                    if (t[k].kind === 'IDENT') this.pushRef(t[k], here().id, t, k);
                i = j - 1;
                continue;
            }

            // ── それ以外の名前は「参照」──
            if (tk.kind === 'IDENT') this.pushRef(tk, here().id, t, i);
        }
    }

    // `(` … `)` を読んで仮引数を登録する。読み終わった位置を返す。
    readParams(start, fnScope, fnDecl) {
        const t = this.tokens;
        let i = start;
        if (!t[i] || t[i].text !== '(') return start;
        i++;
        let expectName = true;
        const sig = [];
        while (i < t.length && !(t[i].kind === 'PUNCT' && t[i].text === ')')) {
            const tk = t[i];
            if (tk.kind === 'PUNCT' && tk.text === ',') {
                expectName = true;
                i++;
                continue;
            }
            // own / mut は名前の前に付く印
            if (tk.kind === 'KEYWORD' && (tk.text === 'own' || tk.text === 'mut')) {
                i++;
                continue;
            }
            if (expectName && tk.kind === 'IDENT') {
                const typeToks = [];
                let j = i + 1;
                if (t[j] && t[j].kind === 'PUNCT' && t[j].text === ':') {
                    j++;
                    let par = 0;
                    while (j < t.length) {
                        const x = t[j];
                        if (x.kind === 'PUNCT' && x.text === '(') par++;
                        if (x.kind === 'PUNCT' && x.text === ')') {
                            if (par === 0) break;
                            par--;
                        }
                        if (par === 0 && x.kind === 'PUNCT' && x.text === ',') break;
                        typeToks.push(x.text);
                        if (x.kind === 'IDENT') this.pushRef(x, fnScope.id, t, j);
                        j++;
                    }
                }
                this.decls.push(decl(tk.text, 'param', tk, {
                    type: joinType(typeToks),
                    detail: this.lineText(tk.line).trim(),
                    scope: fnScope.id,
                }));
                sig.push(tk.text + (typeToks.length ? ': ' + joinType(typeToks) : ''));
                i = j;
                expectName = false;
                continue;
            }
            i++;
        }
        // 戻り型（`-> 型`）
        let j = i + 1;
        const ret = [];
        while (j < this.tokens.length && this.tokens[j].kind !== 'NEWLINE' &&
               !(this.tokens[j].kind === 'PUNCT' && this.tokens[j].text === ':')) {
            if (this.tokens[j].kind === 'IDENT')
                this.pushRef(this.tokens[j], fnScope.id, this.tokens, j);
            if (this.tokens[j].text !== '->') ret.push(this.tokens[j].text);
            j++;
        }
        fnDecl.type = 'fn(' + sig.join(', ') + ')' +
                      (ret.length ? ' -> ' + joinType(ret) : '');
        return i;
    }

    pushRef(tk, scopeId, toks, i) {
        const prev = toks[i - 1];
        const dotted = prev && prev.kind === 'PUNCT' && prev.text === '.';
        this.refs.push({
            name: tk.text,
            line: tk.line,
            col: tk.col,
            length: tk.text.length,
            scope: scopeId,
            member: !!dotted,
            // `a.b` の a（左側）を覚えておく（モジュールか変数かを後で見る）
            base: dotted && toks[i - 2] && toks[i - 2].kind === 'IDENT'
                  ? toks[i - 2].text : '',
        });
    }

    // ── 引く ──────────────────────────────────────────────

    // 位置（0 起点）にあるトークンを返す
    at(line, character) {
        const l = line + 1;
        const c = character + 1;
        for (const d of this.decls)
            if (d.line === l && c >= d.col && c <= d.col + d.length)
                return { decl: d };
        for (const r of this.refs)
            if (r.line === l && c >= r.col && c <= r.col + r.length)
                return { ref: r };
        for (const im of this.imports)
            if (im.line === l && c >= im.col && c <= im.col + im.length)
                return { import: im };
        return null;
    }

    // スコープの鎖（内側から外側へ）
    chain(scopeId) {
        const out = [];
        let s = this.scopes[scopeId];
        while (s) {
            out.push(s);
            s = s.parent >= 0 ? this.scopes[s.parent] : null;
        }
        return out;
    }

    // 参照を宣言へ結ぶ（同じファイルの中だけ）。
    //
    // ⚠️ `a.b` の b（member）はここでは解きません。モジュールやクラスを
    //   またぐので、server.js が持っている「他のファイルの表」が要ります。
    resolve(ref) {
        if (ref.member) return null;
        const ids = this.chain(ref.scope).map((s) => s.id);
        // ① 内側のスコープから順に、変数・仮引数
        for (const id of ids) {
            for (const d of this.decls) {
                if (d.scope !== id) continue;
                if (d.name !== ref.name) continue;
                if (d.kind === 'var' || d.kind === 'param' || d.kind === 'field')
                    return d;
            }
        }
        // ② モジュールの中の関数・クラス・型
        for (const d of this.decls) {
            if (d.scope !== 0) continue;
            if (d.name === ref.name) return d;
        }
        // ③ クラスの中（メソッド・フィールド）
        for (const s of this.chain(ref.scope)) {
            if (s.kind !== 'class') continue;
            for (const d of this.decls)
                if (d.scope === s.id && d.name === ref.name) return d;
        }
        return null;
    }

    findImport(name) {
        return this.imports.find((im) => im.head === name ||
                                         im.module === name) || null;
    }

    topLevel(name) {
        return this.decls.find((d) => d.scope === 0 && d.name === name) || null;
    }

    // クラス C のメンバ（フィールドとメソッド）
    membersOf(className) {
        const s = this.scopes.find((x) => x.kind === 'class' && x.name === className);
        if (!s) return [];
        return this.decls.filter((d) => d.scope === s.id);
    }

    // そのスコープから見えている宣言（補完に使う）
    visible(scopeId) {
        const ids = new Set(this.chain(scopeId).map((s) => s.id));
        return this.decls.filter((d) => ids.has(d.scope));
    }
}

function joinType(parts) {
    let out = '';
    for (const p of parts) {
        if (p === '[' || p === ']' || p === ',' || p === '.') out += p;
        else if (out.endsWith('[') || out.endsWith('.') || out === '') out += p;
        else out += (p === '|' || out.endsWith('|') || out.endsWith(',')
                     ? ' ' : '') + p;
    }
    return out.replace(/,(\S)/g, ', $1').trim();
}

module.exports = { FileIndex, parseTokens, KIND };
