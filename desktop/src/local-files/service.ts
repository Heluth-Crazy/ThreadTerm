import { stat } from 'node:fs/promises';
import { isRecord, validateRequest, validateResult, type FileScope, type Method, type RequestParams, type RequestResult } from '@threadterm/protocol';
import { isWorkspaceContext, type LocalFileCoordination } from './coordination.js';
import type { LocalFileService } from './files.js';
import { canonicalPath } from './paths.js';
import type { FileRequestTarget } from './router.js';
import { LocalFileAccess } from './access.js';

type Mutation = 'filesystem.write' | 'filesystem.create' | 'filesystem.rename' | 'filesystem.delete';
const isMutation = (method: Method): method is Mutation =>
  method === 'filesystem.write' || method === 'filesystem.create' || method === 'filesystem.rename' || method === 'filesystem.delete';
const noEffect = (error: unknown): boolean => error instanceof Error && 'noEffect' in error && error.noEffect === true;

/** Coordinates authority and receipts; project file bytes are read only by the injected Node service. */
export function createLocalFileTarget(options: {
  service: LocalFileService;
  coordination: LocalFileCoordination;
  references: FileRequestTarget;
  access?: LocalFileAccess;
}): FileRequestTarget {
  const { service, coordination, references } = options;
  const access = options.access ?? new LocalFileAccess(coordination);
  const root = async (path: string) => {
    const canonical = await canonicalPath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('invalid_root');
    return canonical;
  };
  async function mutate(accessId: string, method: Mutation, params: RequestParams<Mutation>): Promise<unknown> {
    const admission = await coordination('desktop.files.mutation.begin', { accessId, method, params });
    if (!isRecord(admission)) throw new Error('Invalid file mutation reservation');
    if (admission.kind === 'replay') return admission.result;
    if (admission.kind !== 'execute' || typeof admission.rootPath !== 'string' || typeof admission.reservationId !== 'string') throw new Error('Invalid file mutation reservation');
    let effectMayHaveStarted = false;
    let result: unknown;
    try {
      const path = await root(admission.rootPath);
      effectMayHaveStarted = true;
      switch (method) {
        case 'filesystem.write': result = await service.write(path, params as RequestParams<'filesystem.write'>); break;
        case 'filesystem.create': result = await service.create(path, params as RequestParams<'filesystem.create'>); break;
        case 'filesystem.rename': result = await service.rename(path, params as RequestParams<'filesystem.rename'>); break;
        case 'filesystem.delete': result = await service.delete(path, params as RequestParams<'filesystem.delete'>); break;
      }
    } catch (error) {
      if (!effectMayHaveStarted || noEffect(error)) {
        // A lost abort reply is conservative: the durable claim still prevents a second effect.
        await coordination('desktop.files.mutation.abort', { reservationId: admission.reservationId, effect: 'none' }).catch(() => {});
      }
      throw error;
    }
    validateResult(method, result);
    return coordination('desktop.files.mutation.complete', { reservationId: admission.reservationId, result });
  }

  return {
    async request<M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> {
      validateRequest(method, params);
      return access.run(async accessId => {
        let result: unknown;
        if (method === 'filesystem.resolve' || method.startsWith('filesystem.external.')) {
          result = await references.request(method, params);
        } else if (method === 'filesystem.browse') {
          result = await service.browse((params as RequestParams<'filesystem.browse'>).path);
        } else if (isMutation(method)) {
          result = await mutate(accessId, method, params as RequestParams<Mutation>);
        } else {
          const scope = params as FileScope;
          const context = await coordination('desktop.files.context', {
            kind: 'workspace', projectId: scope.projectId,
            ...(scope.worktreePath !== undefined ? { worktreePath: scope.worktreePath } : {}),
          });
          if (!isWorkspaceContext(context)) throw new Error('Invalid file workspace context');
          const path = await root(context.rootPath);
          switch (method) {
            case 'filesystem.list': result = await service.list(path, params as RequestParams<'filesystem.list'>); break;
            case 'filesystem.read': result = await service.read(path, params as RequestParams<'filesystem.read'>); break;
            case 'filesystem.readWindow': result = await service.readWindow(path, params as RequestParams<'filesystem.readWindow'>); break;
            case 'filesystem.image': result = await service.image(path, params as RequestParams<'filesystem.image'>); break;
            case 'filesystem.files': result = await service.files(path); break;
            case 'filesystem.search': result = await service.search(path, params as RequestParams<'filesystem.search'>); break;
            case 'filesystem.preview.read': result = await service.preview(path, params as RequestParams<'filesystem.preview.read'>); break;
            default: throw new Error('Unsupported local file method');
          }
        }
        validateResult(method, result);
        return result as RequestResult<M>;
      }, isMutation(method));
    },
  };
}
