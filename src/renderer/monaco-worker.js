// Monaco の Web Worker を立ち上げるだけの小さな起動役。
// （AMD 版の monaco は、worker の中でもローダを読ませる作りです）
self.MonacoEnvironment = { baseUrl: '/node_modules/monaco-editor/min/' };
importScripts('/node_modules/monaco-editor/min/vs/loader.js');
require(['vs/editor/editor.worker'], function () {});
