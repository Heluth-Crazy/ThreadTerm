import { join } from 'node:path';
import { LocalFileBackendConfig } from './config.js';
import type { LocalFileCoordination } from './coordination.js';
import { LocalFileService } from './files.js';
import { createLocalFileReferenceTarget } from './references.js';
import { LocalFileRouter } from './router.js';
import { createLocalFileTarget } from './service.js';
import { LocalFileAccess } from './access.js';
import { LocalFileAccessNotCreatedError } from './coordination.js';
import { startSheetReaderProcess } from './sheet-reader-process.js';
import type { SheetReaderFactory } from './sheet-host.js';
import { RuntimeRequestError } from '../runtime-client.js';
export { registerLocalFileBackendIpc } from './ipc.js';

/** All compatibility implementation stays below this removable entry point. */
export function createLocalFileBackend(options: {
  configPath: string;
  coordination: LocalFileCoordination;
  trashItem: (path: string) => Promise<void>;
  /** Where `desktop-dist/sheet-core.wasm` is; the WebAssembly sheet core of main mode. */
  sheetWasmPath?: string;
  /** Overridable so tests and probes can replace the reader process. */
  startSheetReader?: SheetReaderFactory;
}): LocalFileRouter {
  const coordination: LocalFileCoordination = async (command, params) => {
    try { return await options.coordination(command, params); }
    catch (error) {
      const code = error instanceof RuntimeRequestError ? error.code : undefined;
      const notCreated = error instanceof LocalFileAccessNotCreatedError || command === 'desktop.files.access.begin' && (code === 'unknown_method' || code === 'desktop_files_unavailable');
      if (code === 'desktop_files_unavailable' || error instanceof Error && error.message.includes('desktop_files_unavailable')) {
        const message = 'Main-process file access is currently supported on Windows only. / 主进程文件访问目前仅支持 Windows。';
        throw notCreated ? new LocalFileAccessNotCreatedError(message) : new Error(message);
      }
      if (code === 'unknown_method' || error instanceof Error && /unknown_method|method_not_found|unknown method|unsupported.*method/i.test(error.message)) {
        const message = 'local_files_requires_restart: Restart ThreadTerm to update the file service. / 请重启 ThreadTerm 以更新文件服务。';
        throw notCreated ? new LocalFileAccessNotCreatedError(message) : new Error(message);
      }
      throw error;
    }
  };
  const service = new LocalFileService({ trashItem: options.trashItem });
  const access = new LocalFileAccess(coordination);
  const references = createLocalFileReferenceTarget({ service, coordination });
  const sheetWasmPath = options.sheetWasmPath ?? process.env.THREADTERM_SHEET_WASM ?? join(__dirname, 'sheet-core.wasm');
  const main = createLocalFileTarget({
    service, coordination, references, access,
    // Only ThreadTerm.exe parses a workbook in main mode (R22): the reader is a utility
    // process of this executable, and it opens no files.
    sheet: { wasmPath: sheetWasmPath, startReader: options.startSheetReader ?? startSheetReaderProcess },
  });
  return new LocalFileRouter(new LocalFileBackendConfig(options.configPath), main, async backend => {
    await access.flush();
    if (backend === 'main') await access.run(async () => null);
    // Sheet handles belong to the backend that opened them: after a switch the client
    // reopens (`design.md` §3.4, §3.5).
    main.reset?.();
  }, () => access.flush());
}
