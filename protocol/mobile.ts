import type { ChatItem, DevicePermission, InboxItem, ProjectCatalogItem, ProviderCapability, RequestMap, Session, SessionMode, Worktree } from './index';
import { validateResult } from './index';

export const MOBILE_CONTRACT = 1 as const;
export const MOBILE_ALPN = 'threadterm-mobile/1';
export type MobileProvider = Pick<ProviderCapability, 'id'|'name'|'installed'|'terminal'|'chat'|'auth'|'reason'|'version'>;
export interface MobileSnapshot {
  epoch: string;
  revision: number;
  permission: DevicePermission;
  capabilities: { contract: 1; methods: string[] };
  projects: ProjectCatalogItem[];
  worktrees: Worktree[];
  sessions: Session[];
  inbox: InboxItem[];
  providers: MobileProvider[];
  warnings?: { projectId: string; message: string }[];
}
export interface MobileSessionCreate {
  projectId: string;
  worktreeId?: string;
  provider: string;
  mode: SessionMode;
  title?: string;
  operationId: string;
}
export interface MobileMethods {
  'mobile.snapshot': [{}, MobileSnapshot];
  'mobile.session.create': [MobileSessionCreate, Session];
  'mobile.events.subscribe': [{sessionIds: string[]}, {sessionIds: string[]; revision: number}];
}
export type MobileReadMethod = 'runtime.health'|'project.catalog.list'|'worktree.list'|'worktree.branches'|'session.lookup'|'chat.snapshot'|'chat.read'|'chat.subagent.read'|'chat.options'|'chat.connection'|'terminal.read'|'filesystem.list'|'filesystem.read'|'filesystem.files'|'filesystem.search'|'filesystem.image'|'git.status'|'git.diff'|'git.log'|'git.commit.show'|'git.commit.diff'|'git.branches'|'inbox.read'|'session.attention.acknowledge'|'chat.image.read'|'attachment.read';
export type MobileControlMethod = 'session.stop'|'session.resume'|'session.claim'|'session.renew'|'session.release'|'chat.connect'|'chat.send'|'chat.cancel'|'chat.approve'|'chat.answer'|'terminal.input'|'terminal.resize'|'attachment.upload';
export type MobileRequestMap = MobileMethods & Pick<RequestMap, MobileReadMethod|MobileControlMethod>;
export type MobileMethod = keyof MobileRequestMap;
export type MobileParams<M extends MobileMethod> = MobileRequestMap[M][0];
export type MobileResult<M extends MobileMethod> = MobileRequestMap[M][1];

export interface MobileTranscript {
  items: ChatItem[];
  revision: number;
  cursor?: number;
  truncated?: boolean;
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Boundary validation deliberately excludes arbitrary desktop snapshots and unknown authority. */
export function isMobileSnapshot(v: unknown): v is MobileSnapshot {
  if (!record(v) || typeof v.epoch !== 'string' || !v.epoch || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || !['readonly', 'fullcontrol'].includes(String(v.permission))) return false;
  if (Object.keys(v).some(key => !['epoch','revision','permission','capabilities','projects','worktrees','sessions','inbox','providers','warnings'].includes(key))) return false;
  if (!record(v.capabilities) || v.capabilities.contract !== MOBILE_CONTRACT || !Array.isArray(v.capabilities.methods) || !v.capabilities.methods.every(m => typeof m === 'string')) return false;
  for (const key of ['projects', 'worktrees', 'sessions', 'inbox', 'providers']) if (!Array.isArray(v[key]) || !(v[key] as unknown[]).every(row => record(row) && typeof row.id === 'string')) return false;
  try {
    validateResult('project.catalog.list',v.projects);
    validateResult('worktree.list',v.worktrees);
    for (const session of v.sessions as unknown[]) validateResult('session.lookup',session);
  } catch { return false; }
  if (!(v.inbox as Record<string,unknown>[]).every(row => ['id','sessionId','kind','title','createdAt'].every(key => typeof row[key] === 'string') && typeof row.read === 'boolean')) return false;
  if (!(v.providers as Record<string,unknown>[]).every(row => typeof row.name === 'string' && ['installed','terminal','chat'].every(key => typeof row[key] === 'boolean')
    && Object.keys(row).every(key => ['id','name','installed','terminal','chat','auth','reason','version'].includes(key)))) return false;
  return v.warnings === undefined || Array.isArray(v.warnings) && v.warnings.every(warning => record(warning) && typeof warning.projectId === 'string' && typeof warning.message === 'string');
}
