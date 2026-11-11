#!/usr/bin/env node
// Builds the sheet core (`runtime/sheet-core`) for `wasm32-unknown-unknown` and puts the
// module where the main process reads it: `desktop-dist/sheet-core.wasm` (design.md §3.4).
//
//   npm run build:sheet-wasm
//
// Needs the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`) and
// a Rust toolchain; `npm run check:fast` never runs this. The module is the only parser the
// main-process host uses, so `desktop-dist/sheet-core.wasm` is also listed in electron-builder
// `files`.
//
// The linear memory is capped at link time at the same 2 GiB as the runtime helper's job
// memory limit (validation.md S2): a 1.5 GiB build traps with a Rust allocation failure on
// the worst-case string workbook.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outFile = join(root, 'desktop-dist/sheet-core.wasm');
const memoryBytes = 2 * 1024 * 1024 * 1024;
const wasmLib = join(root, 'runtime/target/wasm32-unknown-unknown/release/threadterm_sheet_core.wasm');

function fail(message) {
  console.error(`build:sheet-wasm: ${message}`);
  process.exit(1);
}

const cargo = process.env.CARGO ?? 'cargo';
const rustflags = [process.env.RUSTFLAGS ?? '', `-C link-arg=--max-memory=${memoryBytes}`].filter(Boolean).join(' ');
const build = spawnSync(cargo, [
  'build', '--release', '--target', 'wasm32-unknown-unknown',
  '--manifest-path', join(root, 'runtime/sheet-core/Cargo.toml'),
], { cwd: root, stdio: 'inherit', env: { ...process.env, RUSTFLAGS: rustflags } });
if (build.error?.code === 'ENOENT') fail('cargo was not found; install Rust (rustup) or keep to npm run check:fast');
if (build.status !== 0) fail(`cargo build for wasm32-unknown-unknown failed (status ${build.status})`);
if (!existsSync(wasmLib)) fail(`missing ${relative(root, wasmLib)} after the build; run rustup target add wasm32-unknown-unknown`);

mkdirSync(dirname(outFile), { recursive: true });
copyFileSync(wasmLib, outFile);

// Verify what the host will load: only the four dead `__wbindgen_*` hooks as imports (spike C),
// a 2 GiB memory whose next grow past the cap fails, and the full C ABI.
const module = new WebAssembly.Module(readFileSync(outFile));
const imports = WebAssembly.Module.imports(module);
const unexpected = imports.filter(entry => !/^__wbindgen_/.test(entry.name));
if (unexpected.length) fail(`unexpected wasm imports: ${unexpected.map(entry => `${entry.module}.${entry.name}`).join(', ')}`);
const exports = WebAssembly.Module.exports(module).map(entry => entry.name);
for (const name of ['memory', 'engine_new', 'alloc', 'dealloc', 'feed', 'request', 'reply_ptr', 'reply_len', 'close']) {
  if (!exports.includes(name)) fail(`the module does not export ${name}`);
}
const stubs = {};
for (const entry of imports) {
  stubs[entry.module] = stubs[entry.module] ?? {};
  stubs[entry.module][entry.name] = () => 0;
}
const instance = new WebAssembly.Instance(module, stubs);
const memory = instance.exports.memory;
const pagesToCap = Math.ceil((memoryBytes - memory.buffer.byteLength) / 65536) + 1;
let capped = false;
try {
  memory.grow(pagesToCap);
} catch {
  capped = true;
}
if (!capped) fail(`the linear memory is not capped at ${memoryBytes} bytes`);
const bytes = statSync(outFile).size;
if (bytes < 200 * 1024) fail(`the module is only ${bytes} bytes; the build looks wrong`);
console.log(`build:sheet-wasm: ${relative(root, outFile)} (${(bytes / 1024).toFixed(0)} KiB, memory cap ${memoryBytes / 1024 / 1024 / 1024} GiB, ${imports.length} stub imports)`);
