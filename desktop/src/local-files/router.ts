import type { Method, RequestParams, RequestResult } from '@threadterm/protocol';
import { isLocalFileBackend, type LocalFileBackend } from './config.js';

export interface FileRequestTarget {
  request<M extends Method>(method: M, params: RequestParams<M>, context?: FileRequestContext): Promise<RequestResult<M>>;
  /** The window that sent the request: sheet handles are bound to it (`design.md` §3.4). */
  releaseOwner?(owner: string): void;
  /** The Local file access setting changed: backend-scoped handles are gone (§3.5). */
  reset?(): void;
}
/** Who asked. The runtime host binds a sheet handle to its principal and connection; the main
 * host binds it to the window (webContents) that opened it. */
export type FileRequestContext = { owner?: string };
export interface BackendPreference {
  load(): Promise<LocalFileBackend>;
  save(backend: LocalFileBackend): Promise<void>;
}

const fileMethods = new Set<string>([
  'filesystem.browse', 'filesystem.preview.read', 'filesystem.list', 'filesystem.resolve',
  'filesystem.external.open', 'filesystem.external.read', 'filesystem.external.image',
  'filesystem.external.readWindow', 'filesystem.external.list', 'filesystem.external.forget',
  'filesystem.read', 'filesystem.readWindow', 'filesystem.image',
  'filesystem.write', 'filesystem.create', 'filesystem.rename', 'filesystem.delete',
  'filesystem.files', 'filesystem.search',
  // Excel preview (`design.md` §3.4): the main backend feeds a WebAssembly reader; the runtime
  // backend opens a `--sheet-worker` helper. Remote views always go to their host's runtime.
  'filesystem.sheet.open', 'filesystem.external.sheet.open', 'filesystem.sheet.rows', 'filesystem.sheet.close',
]);
const mutations = new Set<string>([
  'filesystem.write', 'filesystem.create', 'filesystem.rename', 'filesystem.delete',
  'filesystem.external.open', 'filesystem.external.forget',
]);
const lifecycleMethods = new Set<string>([
  'project.remove', 'worktree.remove', 'worktree.relocate', 'data.relocation.prepare', 'runtime.shutdown',
]);

/** One admission boundary for local files. Mode changes drain admitted work before persisting. */
export class LocalFileRouter {
  private backend: LocalFileBackend = 'runtime';
  private gate: Promise<void>;
  private mutationTail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<(backend: LocalFileBackend) => void>();
  private stopping = false;
  /** Sheet handles the local runtime opened. A handle belongs to the backend that opened it, and
   * after a switch the renderer's `close` goes to the new backend; so the router closes these on
   * the runtime itself when the setting moves to main or their window goes (`design.md` §3.5,
   * R5), instead of leaving a helper to its idle timer. */
  private readonly runtimeSheets = new Map<string, { runtime: FileRequestTarget; owner?: string }>();

  constructor(private readonly preference: BackendPreference, private readonly main: FileRequestTarget,
    private readonly prepare?: (backend: LocalFileBackend) => Promise<void>,
    private readonly settleAccess?: () => Promise<void>) {
    this.gate = preference.load().then(backend => { this.backend = backend; });
    // Keep startup errors observable through the next request without an unhandled rejection.
    void this.gate.catch(() => {});
  }

  async getBackend(): Promise<LocalFileBackend> { await this.gate; return this.backend; }

  setBackend(value: unknown): Promise<LocalFileBackend> {
    if (!isLocalFileBackend(value)) return Promise.reject(new Error('Invalid local file backend'));
    if (this.stopping) return Promise.reject(new Error('ThreadTerm is shutting down'));
    return this.exclusive(async () => {
      if (this.backend !== value) {
        await this.prepare?.(value);
        await this.preference.save(value);
        this.backend = value;
        if (value === 'main') this.closeRuntimeSheets(() => true);
        for (const listener of this.listeners) { try { listener(value); } catch { /* A closed window cannot roll back saved preferences. */ } }
      }
      return this.backend;
    });
  }

  /** Keep coordination alive until all admitted operations have a known response. */
  async prepareToQuit(timeoutMs = 30_000): Promise<void> {
    this.stopping = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([this.gate, ...this.pending]).then(() => this.settleAccess?.()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('File operations are still running. Wait for them to finish before quitting.')), timeoutMs);
        }),
      ]);
    } catch (error) { this.stopping = false; throw error; }
    finally { if (timer) clearTimeout(timer); }
  }

  resumeAfterQuitCancelled(): void { this.stopping = false; }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const admitted = [...this.pending], preceding = this.gate;
    const operation = preceding.then(async () => { await Promise.allSettled(admitted); return action(); });
    // Failure keeps the preceding admission state; it never selects a different backend.
    this.gate = operation.then(() => {}, () => preceding);
    void this.gate.catch(() => {});
    return operation;
  }

  onBackendChanged(listener: (backend: LocalFileBackend) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  request<M extends Method>(machineId: string, runtime: FileRequestTarget, method: M, params: RequestParams<M>,
    context?: FileRequestContext): Promise<RequestResult<M>> {
    // Sender bindings choose the machine; host paths must never be interpreted on the controller.
    if (machineId !== 'local') return runtime.request(method, params, context);
    if (!fileMethods.has(method) && !lifecycleMethods.has(method)) return runtime.request(method, params, context);
    if (this.stopping) return Promise.reject(new Error('ThreadTerm is shutting down'));
    if (lifecycleMethods.has(method)) return this.exclusive(async () => {
      await this.settleAccess?.();
      return runtime.request(method, params, context);
    });
    if (this.pending.size >= 256) return Promise.reject(new Error('local_files_busy: Too many pending file requests'));
    const admission = this.gate;
    const beforeMutation = mutations.has(method) ? this.mutationTail : Promise.resolve();
    const operation = Promise.all([admission, beforeMutation]).then(async () => {
      const target = this.backend === 'main' ? this.main : runtime;
      const result = await target.request(method, params, context);
      if (target === runtime) this.trackRuntimeSheet(method, params, result, runtime, context?.owner);
      return result;
    });
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    if (mutations.has(method)) this.mutationTail = operation.then(() => {}, () => {});
    return operation;
  }

  /** A window is gone: drop the sheet handles (and readers or helpers) it opened. */
  releaseOwner(owner: string): void {
    try { this.main.releaseOwner?.(owner); } catch { /* a closed window cannot fail the app */ }
    this.closeRuntimeSheets(entry => entry.owner === owner);
  }

  private trackRuntimeSheet(method: string, params: unknown, result: unknown, runtime: FileRequestTarget, owner?: string): void {
    if (method === 'filesystem.sheet.open' || method === 'filesystem.external.sheet.open') {
      const handle = (result as { handle?: unknown } | null)?.handle;
      if (typeof handle === 'string') this.runtimeSheets.set(handle, { runtime, owner });
    } else if (method === 'filesystem.sheet.close') {
      const handle = (params as { handle?: unknown } | null)?.handle;
      if (typeof handle === 'string') this.runtimeSheets.delete(handle);
    }
  }

  private closeRuntimeSheets(matches: (entry: { runtime: FileRequestTarget; owner?: string }) => boolean): void {
    for (const [handle, entry] of [...this.runtimeSheets]) {
      if (!matches(entry)) continue;
      this.runtimeSheets.delete(handle);
      // `close` is idempotent on the runtime; a runtime that is gone has already ended its helpers.
      void entry.runtime.request('filesystem.sheet.close', { handle }).catch(() => {});
    }
  }
}
