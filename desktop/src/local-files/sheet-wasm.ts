/**
 * The plain C ABI of `runtime/sheet-core`'s `wasm32-unknown-unknown` build (`design.md`
 * §3.2, spike C in `validation.md`): allocate, feed bytes, one JSON request, free. No
 * binding generator is involved, so the module the main-process host loads is exactly the
 * crate the runtime helper compiles natively.
 *
 * The module imports three `__wbindgen_*` hooks (from `getrandom`, which `zip`'s zlib-rs
 * backend pulls in). The random path is dead for a workbook reader, so the host stubs them,
 * as spike C did.
 *
 * The linear memory is capped at link time at 2 GiB (`scripts/build-sheet-wasm.mjs`,
 * `validation.md` S2), the same value as the runtime helper's job memory limit; a Rust
 * allocation past it aborts the module, which the reader reports as `sheet_out_of_memory`.
 */

export type SheetWasmExports = {
  memory: WebAssembly.Memory;
  engine_new(): number;
  alloc(length: number): number;
  dealloc(pointer: number, length: number): void;
  feed(pointer: number, length: number): number;
  request(pointer: number, length: number): number;
  reply_ptr(): number;
  reply_len(): number;
  close(): void;
};

/** What the reader and the parity script use: bytes in, JSON out, no clocks or threads. */
export type SheetEngine = {
  /** Copy one chunk into linear memory and let the core keep it; returns the bytes held. */
  feed(chunk: Uint8Array): number;
  /** One request (`open`/`load`/`rows`/`info`/`close`) and the core's JSON reply. */
  request(json: string): string;
  /** Linear memory in use, in bytes: the reader reports this as its own footprint. */
  linearMemoryBytes(): number;
  close(): void;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** Compile and instantiate the module, stubbing the dead `__wbindgen_*` imports. */
export async function loadSheetWasm(source: Uint8Array | ArrayBuffer): Promise<SheetWasmExports> {
  const module = await WebAssembly.compile(new Uint8Array(source));
  const stubs: Record<string, Record<string, () => number>> = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    stubs[entry.module] = stubs[entry.module] ?? {};
    stubs[entry.module][entry.name] = () => 0;
  }
  const instance = await WebAssembly.instantiate(module, stubs);
  return instance.exports as unknown as SheetWasmExports;
}

export function createSheetEngine(exports: SheetWasmExports): SheetEngine {
  exports.engine_new();
  // Views are recreated after every call that can grow (and therefore detach) the buffer.
  const view = () => new Uint8Array(exports.memory.buffer);
  return {
    feed(chunk: Uint8Array): number {
      const pointer = exports.alloc(chunk.byteLength);
      view().set(chunk, pointer);
      try {
        return exports.feed(pointer, chunk.byteLength);
      } finally {
        exports.dealloc(pointer, chunk.byteLength);
      }
    },
    request(json: string): string {
      const bytes = encoder.encode(json);
      const pointer = exports.alloc(bytes.byteLength);
      view().set(bytes, pointer);
      try {
        const length = exports.request(pointer, bytes.byteLength);
        const reply = view().subarray(exports.reply_ptr(), exports.reply_ptr() + length);
        return decoder.decode(new Uint8Array(reply));
      } finally {
        exports.dealloc(pointer, bytes.byteLength);
      }
    },
    linearMemoryBytes(): number {
      return exports.memory.buffer.byteLength;
    },
    close(): void {
      exports.close();
    },
  };
}
