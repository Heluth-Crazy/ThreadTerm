import type { Method, RequestParams, RequestResult } from '@threadterm/protocol';
import { isLocalFileBackend, type LocalFileBackend } from './config.js';

export interface FileRequestTarget {
  request<M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>>;
}
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

  request<M extends Method>(machineId: string, runtime: FileRequestTarget, method: M, params: RequestParams<M>): Promise<RequestResult<M>> {
    // Sender bindings choose the machine; host paths must never be interpreted on the controller.
    if (machineId !== 'local') return runtime.request(method, params);
    if (!fileMethods.has(method) && !lifecycleMethods.has(method)) return runtime.request(method, params);
    if (this.stopping) return Promise.reject(new Error('ThreadTerm is shutting down'));
    if (lifecycleMethods.has(method)) return this.exclusive(async () => {
      await this.settleAccess?.();
      return runtime.request(method, params);
    });
    if (this.pending.size >= 256) return Promise.reject(new Error('local_files_busy: Too many pending file requests'));
    const admission = this.gate;
    const beforeMutation = mutations.has(method) ? this.mutationTail : Promise.resolve();
    const operation = Promise.all([admission, beforeMutation]).then(() =>
      (this.backend === 'main' ? this.main : runtime).request(method, params));
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    if (mutations.has(method)) this.mutationTail = operation.then(() => {}, () => {});
    return operation;
  }
}
