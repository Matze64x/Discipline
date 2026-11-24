// The few runtime APIs src/core may use beyond plain ECMAScript. All of them exist in browsers,
// Node and the Tauri webview. Only included by tsconfig.core.json (the app config gets them from the DOM lib).
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };
