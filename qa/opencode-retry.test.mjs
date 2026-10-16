import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

// Source-owned renderer tests are TypeScript/TSX but deliberately stay out of
// the browser QA process.  This in-process loader registers their node:test
// cases without spawning a compiler or an Electron child process.
const require = createRequire(import.meta.url);
// Keep TypeScript's CommonJS filesystem dependencies outside ESM test bundles.
const ts = require('typescript');
const cache = new Map();
const extensions = ['', '.ts', '.tsx', '.js', '.jsx'];

function localPath(parent, request) {
  const base = resolve(dirname(parent), request);
  for (const extension of extensions) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const extension of extensions.slice(1)) {
    const candidate = join(base, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve ${request} from ${parent}`);
}

function load(path) {
  path = resolve(path);
  if (cache.has(path)) return cache.get(path).exports;
  const module = { exports: {} };
  cache.set(path, module);
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: path,
  }).outputText;
  const localRequire = request => {
    if (request.endsWith('.css')) return {};
    return request.startsWith('.') ? load(localPath(path, request)) : require(request);
  };
  // Run in this realm so strict assertions see the same object prototypes.
  const factory = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: path });
  factory(localRequire, module, module.exports, path, dirname(path));
  return module.exports;
}

load('renderer/src/providerRetry.test.ts');
