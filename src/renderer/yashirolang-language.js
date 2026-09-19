// Monaco に yashirolang（.ys）を教える。
// 文法の色付けと、行頭インデントの面倒だけを見ます。
'use strict';

const YS_LANGUAGE_ID = 'yashirolang';

// src/lexer.c の KEYWORDS と揃えてあります。
const YS_KEYWORDS = [
  'and', 'as', 'break', 'class', 'continue', 'def', 'elif', 'else',
  'extern', 'False', 'for', 'if', 'import', 'in', 'is', 'None',
  'not', 'or', 'pass', 'return', 'True', 'while',
  'own', 'mut', 'raises', 'unsafe', 'pragma', 'interface',
  // 予約済み（使うとコンパイラが止めます。色を変えて気づけるように）
  'assert', 'const', 'del', 'except', 'finally', 'from', 'global', 'lambda',
  'match', 'nonlocal', 'raise', 'try', 'with', 'yield',
];

const YS_TYPES = ['int', 'float', 'bool', 'str', 'bytes', 'list', 'dict', 'set', 'rc', 'void'];

const YS_BUILTINS = [
  'abs', 'chr', 'copy', 'exit', 'float', 'hash', 'input', 'int', 'len',
  'ord', 'panic', 'print', 'range', 'str', 'sum', 'move_out',
];

function registerYashirolang(monaco) {
  monaco.languages.register({ id: YS_LANGUAGE_ID, extensions: ['.ys'], aliases: ['yashirolang', 'ys'] });

  monaco.languages.setLanguageConfiguration(YS_LANGUAGE_ID, {
    comments: { lineComment: '#' },
    brackets: [['(', ')'], ['[', ']'], ['{', '}']],
    autoClosingPairs: [
      { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '(', close: ')' }, { open: '[', close: ']' },
      { open: '"', close: '"' }, { open: "'", close: "'" },
    ],
    // ★ Python と同じで、`:` で終わる行の次は 1 段下げます。
    onEnterRules: [{
      beforeText: /^\s*(def|if|elif|else|for|while|class|interface|extern|unsafe)\b.*:\s*$/,
      action: { indentAction: monaco.languages.IndentAction.Indent },
    }],
    indentationRules: {
      increaseIndentPattern: /:\s*$/,
      decreaseIndentPattern: /^\s*(elif|else|except|finally)\b.*:\s*$/,
    },
  });

  monaco.languages.setMonarchTokensProvider(YS_LANGUAGE_ID, {
    defaultToken: '',
    keywords: YS_KEYWORDS,
    typeKeywords: YS_TYPES,
    builtins: YS_BUILTINS,
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        // 契約と属性（pragma / Pre / Post）
        [/^\s*pragma\b.*$/, 'annotation'],
        [/"""/, { token: 'string.quote', next: '@dq3' }],
        [/'''/, { token: 'string.quote', next: '@sq3' }],
        [/"/, { token: 'string.quote', next: '@dq' }],
        [/'/, { token: 'string.quote', next: '@sq' }],
        [/\b0[xX][0-9a-fA-F_]+\b/, 'number.hex'],
        [/\b0[bB][01_]+\b/, 'number.binary'],
        [/\b\d[\d_]*\.\d[\d_]*([eE][-+]?\d+)?\b/, 'number.float'],
        [/\b\d[\d_]*\b/, 'number'],
        [/\b(def)(\s+)([A-Za-z_]\w*)/, ['keyword', '', 'entity.name.function']],
        [/[A-Za-z_]\w*(?=\s*\()/, {
          cases: { '@builtins': 'support.function', '@keywords': 'keyword', '@default': 'identifier' },
        }],
        [/[A-Za-z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@typeKeywords': 'type',
            '@builtins': 'support.function',
            '@default': 'identifier',
          },
        }],
        [/->|[=!<>]=|[-+*/%<>=&|^~]/, 'operator'],
        [/[()\[\]{}]/, '@brackets'],
        [/[,;:.]/, 'delimiter'],
      ],
      dq:  [[/[^\\"]+/, 'string'], [/\\./, 'string.escape'], [/"/, { token: 'string.quote', next: '@pop' }]],
      sq:  [[/[^\\']+/, 'string'], [/\\./, 'string.escape'], [/'/, { token: 'string.quote', next: '@pop' }]],
      dq3: [[/[^"]+/, 'string'], [/"""/, { token: 'string.quote', next: '@pop' }], [/"/, 'string']],
      sq3: [[/[^']+/, 'string'], [/'''/, { token: 'string.quote', next: '@pop' }], [/'/, 'string']],
    },
  });

  // 補完は「よく使う形」を出すだけの控えめなものに留めます。
  monaco.languages.registerCompletionItemProvider(YS_LANGUAGE_ID, {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: word.startColumn, endColumn: word.endColumn,
      };
      const K = monaco.languages.CompletionItemKind;
      const items = [
        ...YS_KEYWORDS.map((k) => ({ label: k, kind: K.Keyword, insertText: k, range })),
        ...YS_TYPES.map((k) => ({ label: k, kind: K.TypeParameter, insertText: k, range })),
        ...YS_BUILTINS.map((k) => ({ label: k, kind: K.Function, insertText: `${k}($0)`, range,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })),
        {
          label: 'main', kind: K.Snippet, range,
          insertText: 'def main() -> int:\n    $0\n    return 0',
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: 'エントリポイント',
        },
        {
          label: 'for', kind: K.Snippet, range,
          insertText: 'for ${1:i} in range(${2:0}, ${3:10}):\n    $0',
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        },
      ];
      return { suggestions: items };
    },
  });

  // 暗い方の色。Monaco 既定の vs-dark に、この言語の分だけ足します。
  monaco.editor.defineTheme('yashiro-dark', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c678dd' },
      { token: 'type', foreground: '56b6c2' },
      { token: 'support.function', foreground: '61afef' },
      { token: 'entity.name.function', foreground: 'e5c07b' },
      { token: 'string', foreground: '98c379' },
      { token: 'comment', foreground: '6b7684', fontStyle: 'italic' },
      { token: 'number', foreground: 'd19a66' },
      { token: 'annotation', foreground: 'e0a33e' },
    ],
    colors: { 'editor.background': '#1e2227', 'editorGutter.background': '#1e2227' },
  });
  monaco.editor.defineTheme('yashiro-light', {
    base: 'vs', inherit: true,
    rules: [
      { token: 'keyword', foreground: 'a626a4' },
      { token: 'type', foreground: '0184bc' },
      { token: 'support.function', foreground: '4078f2' },
      { token: 'entity.name.function', foreground: 'c18401' },
      { token: 'string', foreground: '50a14f' },
      { token: 'comment', foreground: '9099a5', fontStyle: 'italic' },
      { token: 'number', foreground: '986801' },
    ],
    colors: {},
  });
}
