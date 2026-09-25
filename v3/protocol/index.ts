import { validateWireRequest, validateWireSuccess } from './generated-validators.js';
export const PROTOCOL_VERSION = 1 as const;
/** Semantic contract for Chat approvals (`choiceId`) and connection status. Framing/HMAC still use PROTOCOL_VERSION. */
export const PROTOCOL_CONTRACT = 2 as const;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export type ProviderId = 'codex'|'claude'|'kimi'|'gemini'|'opencode'|'shell'|'grok'|'custom';
export type SessionMode = 'terminal'|'chat';
export type SessionStatus = 'starting'|'running'|'idle'|'waiting'|'exited'|'interrupted'|'error';
export interface Project { id:string; name:string; path:string; createdAt:string }
export interface CommitSummary { id:string; subject:string; committedAt:string }
export interface ProjectCatalogItem extends Project { revision:number; pinned:boolean; sortOrder:number; git:{available:boolean;branch?:string;upstream?:string;lastCommit?:CommitSummary} }
export interface CatalogVisibility { kind:'project'|'worktree'|'session'; id:string; visibility:'active'|'archived'|'removed'; revision:number; projectId?:string; worktreePath?:string }
export interface LocalBranch { name:string; current:boolean; upstream?:string; lastCommit:CommitSummary }
export interface Session { id:string; projectId?:string; worktreePath?:string; title:string; provider:ProviderId; mode:SessionMode; status:SessionStatus; createdAt:string; updatedAt:string; nativeId?:string; exitCode?:number; cols?:number; rows?:number; followed?:boolean; readOnly?:boolean; archived?:boolean; pinned?:boolean; bookmarked?:boolean; intent?:'review'|'fix'|'research'|'test'|'docs'; sortOrder?:number; organizationRevision?:number }
export interface SessionConfig { sessionId:string; revision:number; provider:ProviderId; mode:SessionMode; cwd:string; projectId?:string; title?:string; executable?:string; args:string[]; sourceSessionId?:string }
export interface SessionRetryAttempt { id:string; sourceSessionId:string; attempt:number; dueAt:string; status:'pending'|'claimed'|'cancelled'|'completed'|'exhausted'; operationId:string; createdAt:string }
export interface SessionRetryState { sessionId:string; revision:number; enabled:boolean; maxRetries:number; delaySeconds:number; attempts:SessionRetryAttempt[] }
export interface ProviderCapability { id:ProviderId; name:string; installed:boolean; version?:string; terminal:boolean; chat:boolean; history:boolean; resume:boolean; terminalResumeCapture?:'preassigned'|'none'; reason?:string; auth?:'authenticated'|'unauthenticated'|'unknown' }
export interface Settings { revision:number; theme?:'light'|'dark'|'system'; language?:'zh-CN'|'en'; [key:string]:unknown }
export interface Workspace { id:string; name:string; revision:number; layout:PaneLayout; projectId?:string; worktreePath?:string }
export interface Preset { id:string; name:string; revision:number; sessions:unknown[]; layout:PaneLayout; commands:string[] }
export interface InboxItem { id:string; sessionId:string; kind:string; title:string; createdAt:string; read:boolean }
export interface Snapshot { epoch:string; revision:number; projects:Project[]; sessions:Session[]; settings:Settings; workspaces:Workspace[]; presets:Preset[]; inbox:InboxItem[]; providers:ProviderCapability[] }
export interface NativeHistoryItem { provider:ProviderId; nativeId:string; title:string; cwd?:string; updatedAt:string; resumable:boolean; reason?:string }
export interface ChatPart { type:'text'|'thinking'|'tool'|'approval'|'usage'|'error'|'status'; text?:string; toolName?:string; toolId?:string; approvalId?:string; status?:string; data?:unknown }
export interface ChatItem { id:string; role:'user'|'assistant'|'system'|'tool'; parts:ChatPart[]; createdAt:string; turnId?:string; elapsedMs?:number }
export interface ChatSessionChoice { value:string; name:string }
export interface ChatSessionOption { id:string; name:string; value:string; choices:ChatSessionChoice[] }
export interface ChatSlashCommand { name:string; description?:string }
export type ChatOptionsLoadState = 'idle'|'loading'|'ready'|'empty'|'error'|'unknown';
export interface ChatUiState {
 options:ChatSessionOption[];
 commands:ChatSlashCommand[];
 loadState?:ChatOptionsLoadState;
 error?:{code:string;message:string};
}
export type ChatConnectionPhase = 'disconnected'|'connecting'|'ready'|'failed'|'unavailable';
export interface ChatConnectionError {
 code:string;
 message:string;
 retryable:boolean;
 category?:'auth'|'install'|'version'|'cwd'|'runtime'|'control'|'provider';
}
export interface ChatConnectionState {
 sessionId:string;
 runtimeEpoch:string;
 connectionGeneration:number;
 revision:number;
 phase:ChatConnectionPhase;
 nativeId?:string;
 error?:ChatConnectionError;
 optionsLoadState:ChatOptionsLoadState;
 optionsError?:{code:string;message:string};
}
export type ChatApprovalKind = 'allow'|'deny'|'cancel'|'other';
export type ChatApprovalScope = 'once'|'turn'|'session'|'persistent'|'unknown';
export interface ChatApprovalChoice {
 choiceId:string;
 label:string;
 kind:ChatApprovalKind;
 scope:ChatApprovalScope;
 description?:string;
}
export type ChatApprovalOutcome = 'pending'|'submitting'|'resolved'|'expired'|'failed'|'outcomeUnknown';
export interface ChatApprovalData {
 approvalId:string;
 sessionId?:string;
 turnId?:string;
 provider?:ProviderId;
 requestType?:string;
 title?:string;
 details?:unknown;
 choices:ChatApprovalChoice[];
 interaction?:'permission'|'userInput'|'elicitation'|'unknown';
 submittable?:boolean;
}
export interface RuntimeError { code:string; message:string; details?:unknown }
export type DevicePermission = 'readonly'|'fullcontrol';
export interface RemoteAccessStatus { enabled:boolean; url?:string; port?:number; tlsFingerprint:string; error?:string }
export interface PairingOffer { id:string; code:string; qrPayload:string; permission:DevicePermission; expiresAt:string; serverUrl:string; tlsFingerprint:string }
export interface PairedDevice { id:string; name:string; permission:DevicePermission; createdAt:string; expiresAt:string; lastSeenAt?:string; revokedAt?:string }
export interface DataRelocationStatus { frozen:boolean; sourceRoot:string; targetRoot?:string }
export interface DataRelocationPrepared { sourceRoot:string; targetRoot:string; activationToken:string }
export interface RuntimeEvent { v:1; event:string; epoch:string; seq:number; data:unknown }
export interface TerminalLaunchState { phase:'preparing'|'launching'|'running'|'failed'|'cancelled'; error?:{code:string;message:string} }
export interface RequestMap {
 'session.launch.read': [{sessionId:string},TerminalLaunchState];
 'catalog.visibility.list': [{},CatalogVisibility[]];
 'catalog.visibility.update': [{kind:CatalogVisibility['kind'];id:string;visibility:CatalogVisibility['visibility'];expectedRevision:number;operationId:string},CatalogVisibility];
 'device.status': [{},RemoteAccessStatus];
 'device.enable': [{operationId:string},RemoteAccessStatus];
 'device.disable': [{operationId:string},RemoteAccessStatus];
 'device.pairing.create': [{permission:DevicePermission;operationId:string},PairingOffer];
 'device.pairing.cancel': [{pairingId:string;operationId:string},null];
 'device.list': [{},PairedDevice[]];
 'device.rename': [{deviceId:string;name:string;operationId:string},PairedDevice];
 'device.renew': [{deviceId:string;operationId:string},PairedDevice];
 'device.revoke': [{deviceId:string;operationId:string},null];
 'terminal.read': [{sessionId:string;cursor?:number;limit?:number;tail?:boolean},{sessionId:string;fromCursor:number;nextCursor:number;truncated:boolean;encoding:'base64';data:string}];
 'session.lookup': [{operationId:string},Session|null];
 'session.resume': [{sessionId:string;cwd?:string;operationId:string},Session];
 'session.rerun': [{sessionId:string;operationId:string},Session];
 'session.present': [{sessionId:string;placement:'workspace'|'window';presentation:'background'|'focused';workspacePath?:string;operationId:string},{queued:boolean}];
 'chat.read': [{sessionId:string},ChatItem[]];
 'chat.snapshot': [{sessionId:string},{items:ChatItem[];revision:number}];
 'chat.draft.read': [{sessionId:string},{text:string;revision:number}];
 'chat.draft.save': [{sessionId:string;text:string;expectedRevision:number;leaseEpoch:number;operationId:string},{text:string;revision:number}];
 'data.status': [{},DataStatus];
 'data.backup': [{targetPath:string;operationId:string},{path:string;sizeBytes:number}];
 'data.relocation.status': [{},DataRelocationStatus];
 'data.relocation.prepare': [{targetPath:string;operationId:string},DataRelocationPrepared];
 'data.relocation.cancel': [{preparedOperationId:string;operationId:string},null];
 'settings.export': [{},SettingsBundle];
 'settings.import.preview': [{bundle:string},{valid:boolean;issues:string[];currentRevision:number;changes:{key:string;current:unknown;incoming:unknown}[]}];
 'settings.import.apply': [{bundle:string;selected:string[];expectedRevision:number;operationId:string},Settings];
 'preset.list': [{},Preset[]];
 'preset.save': [{id?:string;name:string;sessions:unknown[];layout:PaneLayout;commands:string[];expectedRevision:number;operationId:string},Preset];
 'preset.delete': [{id:string;expectedRevision:number;operationId:string},null];
 'usage.query': [{from?:string;to?:string;sessionId?:string;projectId?:string;provider?:ProviderId;status?:SessionStatus;source?:UsageSource;sourceSessionId?:string},UsageResult];

 'runtime.health': [{},{version:string;epoch:string;contract:number}];
 'runtime.shutdown': [{operationId:string},null];
 'runtime.snapshot': [{},Snapshot];
 'project.add': [{path:string;name?:string;operationId:string},Project];
 'project.remove': [{id:string;operationId:string},null];
 'project.catalog.list': [{},ProjectCatalogItem[]];
 'project.update': [{id:string;name?:string;pinned?:boolean;sortOrder?:number;expectedRevision:number;operationId:string},ProjectCatalogItem];
 'session.create': [{projectId?:string;cwd:string;title?:string;provider:ProviderId;mode:SessionMode;executable?:string;args?:string[];nativeId?:string;deferLaunch?:boolean;operationId:string},Session];
 'history.import': [{projectId?:string;provider:ProviderId;nativeId:string;cwd:string;mode:SessionMode;title?:string;operationId:string},Session];
 'session.config.read': [{sessionId:string},SessionConfig];
 'session.config.save': [{sessionId:string;provider:ProviderId;mode:SessionMode;cwd:string;projectId?:string;title?:string;executable?:string;args?:string[];expectedRevision:number;operationId:string},SessionConfig];
 'session.retry.read': [{sessionId:string},SessionRetryState];
 'session.retry.update': [{sessionId:string;enabled:boolean;maxRetries?:number;delaySeconds?:number;expectedRevision:number;operationId:string},SessionRetryState];
 'session.stop': [{sessionId:string;operationId:string;force?:boolean},null];
 'session.organize': [{sessionId:string;archived?:boolean;pinned?:boolean;bookmarked?:boolean;intent?:'review'|'fix'|'research'|'test'|'docs'|'none';sortOrder?:number;expectedRevision:number;operationId:string},Session];
 'session.update': [{sessionId:string;title?:string;followed?:boolean;operationId:string},Session];
 'session.claim': [{sessionId:string;clientId:string},{leaseEpoch:number}];
 'session.renew': [{sessionId:string;leaseEpoch:number},{leaseEpoch:number}];
 'session.release': [{sessionId:string;leaseEpoch:number},null];
 'terminal.input': [{sessionId:string;data:string;leaseEpoch:number},null];
 'terminal.resize': [{sessionId:string;cols:number;rows:number;leaseEpoch:number},null];
 'settings.update': [{patch:Record<string,unknown>;expectedRevision:number;operationId:string},Settings];
 'provider.list': [{},ProviderCapability[]];
 'history.list': [{provider:ProviderId;cursor?:string;limit?:number;cwd?:string},{items:NativeHistoryItem[];nextCursor?:string}];
 'history.read': [{provider:ProviderId;nativeId:string},ChatItem[]];
 'chat.send': [{sessionId:string;text:string;operationId:string;leaseEpoch:number},{turnId:string}];
 'chat.cancel': [{sessionId:string;turnId:string;leaseEpoch:number},null];
 'chat.approve': [{sessionId:string;turnId:string;approvalId:string;choiceId:string;leaseEpoch:number;operationId:string},null];
 'chat.options': [{sessionId:string},ChatUiState];
 'chat.option.set': [{sessionId:string;optionId:string;value:string;leaseEpoch:number;operationId:string},ChatUiState];
 'chat.connection': [{sessionId:string},ChatConnectionState];
 'chat.connect': [{sessionId:string;leaseEpoch:number;operationId:string},ChatConnectionState];
 'filesystem.list': [FileScope&{path:string},FileEntry[]];
 'filesystem.read': [FileScope&{path:string},FileDocument];
 'filesystem.image': [FileScope&{path:string},{mime:'image/png'|'image/jpeg'|'image/gif'|'image/webp';data:string}];
 'filesystem.write': [FileScope&{path:string;content:string;expectedFingerprint:string;operationId:string},FileDocument];
 'draft.list': [FileScope,Draft[]];
 'draft.put': [FileScope&{path:string;content:string;baseFingerprint:string;expectedRevision:number;operationId:string},Draft];
 'draft.delete': [{id:string;expectedRevision:number;operationId:string},null];
 'git.status': [FileScope,GitStatus];
 'git.stage': [FileScope&{paths:string[];expectedFingerprints?:Record<string,string>;operationId:string},{paths:string[]}];
 'git.unstage': [FileScope&{paths:string[];expectedFingerprints?:Record<string,string>;operationId:string},{paths:string[]}];
 'git.commit': [FileScope&{message:string;operationId:string},{commit:string}];
 'git.fetch': [FileScope&{operationId:string},{output:string}];
 'git.pull': [FileScope&{operationId:string},{output:string}];
 'git.push': [FileScope&{operationId:string},{output:string}];
 'git.merge': [FileScope&{branch:string;operationId:string},{output:string;conflicted:boolean}];
 'git.merge.abort': [FileScope&{operationId:string},{output:string}];
 'git.diff': [FileScope&{path:string;staged:boolean},GitDiff];
 'worktree.list': [{projectId:string},Worktree[]];
 'worktree.create': [{projectId:string;path:string;branch:string;createBranch:boolean;operationId:string},Worktree];
 'worktree.remove': [{id:string;operationId:string},null];
 'worktree.branches': [{projectId:string},LocalBranch[]];
 'worktree.relocate': [{id:string;path:string;operationId:string},Worktree];
 'workspace.save': [WorkspaceSave,Workspace];
 'workspace.delete': [{id:string;expectedRevision:number;operationId:string},null];
 'inbox.read': [{ids:string[];operationId:string},null];
}
export type Method = keyof RequestMap;
export type RequestParams<M extends Method> = RequestMap[M][0];
export type RequestResult<M extends Method> = RequestMap[M][1];
export interface OutputChunk { sessionId:string; cursor:number; data:Uint8Array; gap?:boolean }
export interface ThreadTermBridge {
 readonly platform:string;
 readonly windowsPty?:{backend:'conpty';buildNumber:number};
 request<M extends Method>(method:M,params:RequestParams<M>):Promise<RequestResult<M>>;
 onEvent(listener:(event:RuntimeEvent)=>void):()=>void;
 onDesktopNavigate(listener:(target:{sessionId?:string;workspaceId?:string;action?:"command-palette"})=>void):()=>void;
 windowState():Promise<{maximized:boolean}>;
 onWindowState(listener:(state:{maximized:boolean})=>void):()=>void;
 subscribeOutput(sessionId:string,cursor:number,onChunk:(chunk:OutputChunk)=>void|Promise<void>):Promise<()=>void>;
 chooseDirectory():Promise<string|null>;
 chooseSavePath(kind:'database'|'settings'|'theme'):Promise<string|null>;
 activateDataRelocation(prepared:DataRelocationPrepared):Promise<{activated:boolean}>;
 windowAction(action:'minimize'|'maximize'|'close'|'quit'):Promise<void>;
 openWindow(options:{sessionId?:string;workspaceId?:string}):Promise<void>;
 openExternal(url:string):Promise<void>;
 openDirectory(projectId:string,worktreeId?:string):Promise<void>;
 desktopPreferences():Promise<{shortcuts:Record<string,string>}>;
 testNotification():Promise<{sent:boolean;reason?:string}>;
 exportDiagnostics():Promise<string|null>;
 scheduleElectronCacheCleanup(schedule:boolean):Promise<{scheduled:boolean;available:boolean;result?:string}>;
}
export const METHODS = ['session.launch.read','catalog.visibility.list','catalog.visibility.update','session.resume','session.organize','git.merge','git.merge.abort','project.catalog.list','project.update','worktree.branches','worktree.relocate','session.rerun','git.fetch','git.pull','git.push','session.config.read','session.config.save','session.retry.read','session.retry.update','chat.draft.read','chat.draft.save','device.status','device.enable','device.disable','device.pairing.create','device.pairing.cancel','device.list','device.rename','device.renew','device.revoke','git.stage','git.unstage','git.commit','filesystem.image','chat.snapshot','terminal.read','session.lookup','session.present','chat.read','data.status','data.backup','data.relocation.status','data.relocation.prepare','data.relocation.cancel','settings.export','settings.import.preview','settings.import.apply','preset.list','preset.save','preset.delete','usage.query','runtime.health','runtime.shutdown','runtime.snapshot','project.add','project.remove','session.create','history.import','session.stop','session.update','session.claim','session.renew','session.release','terminal.input','terminal.resize','settings.update','provider.list','history.list','history.read','chat.send','chat.cancel','chat.approve','chat.options','chat.option.set','chat.connection','chat.connect','filesystem.list','filesystem.read','filesystem.write','draft.list','draft.put','draft.delete','git.status','git.diff','worktree.list','worktree.create','worktree.remove','workspace.save','workspace.delete','inbox.read'] as const satisfies readonly Method[];
const stringFields: Partial<Record<Method,readonly string[]>> = {
 'session.launch.read':['sessionId'],
 'catalog.visibility.update':['kind','id','visibility','operationId'],
 'session.resume':['sessionId','operationId'],
 'session.organize':['sessionId','operationId'],'git.merge':['projectId','branch','operationId'],'git.merge.abort':['projectId','operationId'],
 'project.update':['id','operationId'],'worktree.branches':['projectId'],'worktree.relocate':['id','path','operationId'],
 'device.enable':['operationId'],'device.disable':['operationId'],'device.pairing.create':['permission','operationId'],'device.pairing.cancel':['pairingId','operationId'],'device.rename':['deviceId','name','operationId'],'device.renew':['deviceId','operationId'],'device.revoke':['deviceId','operationId'],
 'terminal.read':['sessionId'],'session.lookup':['operationId'],'session.present':['sessionId','placement','presentation','operationId'],
 'chat.read':['sessionId'],
 'chat.snapshot':['sessionId'],
 'data.backup':['targetPath','operationId'],'data.relocation.prepare':['targetPath','operationId'],'data.relocation.cancel':['preparedOperationId','operationId'],'settings.import.preview':['bundle'],'settings.import.apply':['bundle','operationId'],'preset.save':['name','operationId'],'preset.delete':['id','operationId'],
 'runtime.shutdown':['operationId'],
 'project.add':['path','operationId'],'project.remove':['id','operationId'],
 'session.create':['cwd','provider','mode','operationId'],'history.import':['cwd','provider','nativeId','mode','operationId'],'session.config.read':['sessionId'],'session.config.save':['sessionId','cwd','provider','mode','operationId'],'session.retry.read':['sessionId'],'session.retry.update':['sessionId','operationId'],'session.stop':['sessionId','operationId'],
 'session.update':['sessionId','operationId'],'session.claim':['sessionId','clientId'],'session.release':['sessionId'],
 'session.renew':['sessionId'],
 'terminal.input':['sessionId','data'],'terminal.resize':['sessionId'],
 'settings.update':['operationId'],'history.list':['provider'],'history.read':['provider','nativeId'],
 'chat.send':['sessionId','text','operationId'],'chat.cancel':['sessionId','turnId'],
 'chat.approve':['sessionId','turnId','approvalId','choiceId','operationId'],
 'chat.options':['sessionId'],'chat.option.set':['sessionId','optionId','value','operationId'],
 'chat.connection':['sessionId'],'chat.connect':['sessionId','operationId'],
 'filesystem.list':['projectId'], 'filesystem.read':['projectId','path'],
 'filesystem.write':['projectId','path','expectedFingerprint','operationId'],
 'draft.list':['projectId'],'draft.put':['projectId','path','baseFingerprint','operationId'],
 'draft.delete':['id','operationId'],'git.status':['projectId'],'git.diff':['projectId','path'],
 'worktree.list':['projectId'],'worktree.create':['projectId','path','branch','operationId'],
 'worktree.remove':['id','operationId'],'workspace.save':['name','operationId'],
 'workspace.delete':['id','operationId'],'inbox.read':['operationId'],
};
export function isRecord(value:unknown):value is Record<string,unknown> { return typeof value==='object' && value!==null && !Array.isArray(value); }
export function validateRequest(method:unknown,params:unknown):asserts method is Method {
 if(typeof method!=='string'||!(METHODS as readonly string[]).includes(method)) throw new Error('Unsupported runtime method');
 if(!isRecord(params)) throw new Error('Request parameters must be an object');
 if(!validateWireRequest({v:1,id:'boundary',method,params})) throw new Error('Request does not match the protocol schema');
 const m=method as Method;
 for(const key of stringFields[m]??[]) if(typeof params[key]!=='string'||(key!=='data'&&params[key]==='')) throw new Error(`Invalid ${key}`);
 if(m==='device.pairing.create'&&!['readonly','fullcontrol'].includes(String(params.permission))) throw new Error('Invalid device permission');
 if(m==='catalog.visibility.update') {
  if(!['project','worktree','session'].includes(String(params.kind))) throw new Error('Invalid catalog kind');
  if(!['active','archived','removed'].includes(String(params.visibility))) throw new Error('Invalid catalog visibility');
 }
 if(m==='device.rename') {
  const name=String(params.name).trim();
  if(name.length===0||[...name].length>80) throw new Error('Invalid device name');
 }
 if(m==='session.stop'&&params.force!==undefined&&typeof params.force!=='boolean') throw new Error('Invalid force');
 if('leaseEpoch' in params && (!Number.isSafeInteger(params.leaseEpoch)||Number(params.leaseEpoch)<1)) throw new Error('Invalid leaseEpoch');
 if(['session.renew','session.release','terminal.input','terminal.resize','chat.send','chat.cancel','chat.approve','chat.option.set','chat.connect'].includes(m)&&!('leaseEpoch' in params)) throw new Error('Missing leaseEpoch');
 if(m==='terminal.resize') for(const key of ['cols','rows']) if(!Number.isInteger(params[key])||Number(params[key])<1||Number(params[key])>1000) throw new Error(`Invalid ${key}`);
 if(m==='session.create'||m==='history.import'||m==='session.config.save') {
  if(!['codex','claude','kimi','gemini','opencode','shell','grok','custom'].includes(String(params.provider))) throw new Error('Invalid provider');
  if(!['terminal','chat'].includes(String(params.mode))) throw new Error('Invalid mode');
  if(params.args!==undefined&&(!Array.isArray(params.args)||params.args.some(x=>typeof x!=='string'))) throw new Error('Invalid args');
 }
 if(m==='settings.update'&&(!isRecord(params.patch)||!Number.isSafeInteger(params.expectedRevision))) throw new Error('Invalid settings revision or patch');
 if(m==='chat.approve'&&(typeof params.choiceId!=='string'||!params.choiceId)) throw new Error('Invalid approval choice');
 if(m==='filesystem.list' && typeof params.path!=='string') throw new Error('Invalid path');
 if(['filesystem.write','draft.put'].includes(m) && (typeof params.content!=='string'||params.content.length>1024*1024)) throw new Error('Invalid file content');
 if(['catalog.visibility.update','session.organize','project.update','draft.put','draft.delete','workspace.save','workspace.delete','settings.import.apply','preset.save','preset.delete','session.config.save','session.retry.update'].includes(m)&&(!Number.isSafeInteger(params.expectedRevision)||Number(params.expectedRevision)<0)) throw new Error('Invalid revision');
 if(m==='git.diff'&&typeof params.staged!=='boolean') throw new Error('Invalid diff mode');
 if(m==='session.retry.update' && (typeof params.enabled!=='boolean'||(params.maxRetries!==undefined&&(!Number.isInteger(params.maxRetries)||Number(params.maxRetries)<1||Number(params.maxRetries)>10))||(params.delaySeconds!==undefined&&(!Number.isInteger(params.delaySeconds)||Number(params.delaySeconds)<1||Number(params.delaySeconds)>3600)))) throw new Error('Invalid retry policy');
 if(m==='worktree.create'&&typeof params.createBranch!=='boolean') throw new Error('Invalid branch mode');
 if(m==='inbox.read'&&(!Array.isArray(params.ids)||params.ids.length>500||params.ids.some(id=>typeof id!=='string'||!id))) throw new Error('Invalid inbox ids');
 if(m==='workspace.save'||m==='preset.save') validateLayout(params.layout);
 if(m==='terminal.read') {
  if(params.cursor!==undefined&&(!Number.isSafeInteger(params.cursor)||Number(params.cursor)<0)) throw new Error('Invalid output cursor');
  if(params.tail===true&&params.cursor!==undefined) throw new Error('tail and cursor are mutually exclusive');
 }
 const maxLimit=m==='terminal.read'?(params.tail===true?8192:1024*1024):200;
 if(params.limit!==undefined&&(!Number.isInteger(params.limit)||Number(params.limit)<1||Number(params.limit)>maxLimit)) throw new Error('Invalid page limit');
}
export function validateResult<M extends Method>(method:M,result:unknown):asserts result is RequestResult<M> {
 if(!validateWireSuccess({v:1,id:'boundary',method,result})) throw new Error(`Invalid runtime result for ${method}`);
}
export function validateLayout(value:unknown):asserts value is PaneLayout {
 let panes=0; const ids=new Set<string>();
 function visit(node:unknown,depth:number):void {
  if(depth>4||!isRecord(node)||typeof node.id!=='string'||!node.id||ids.has(node.id)) throw new Error('Invalid workspace layout');
  ids.add(node.id);
  if(node.kind==='split') {
   if(!['horizontal','vertical'].includes(String(node.direction))||typeof node.ratio!=='number'||node.ratio<0.1||node.ratio>0.9) throw new Error('Invalid workspace split');
   visit(node.first,depth+1); visit(node.second,depth+1);
  } else if(node.kind==='pane') {
   panes++; if(panes>4||!Array.isArray(node.tabs)||node.tabs.length>100) throw new Error('Invalid workspace panes');
   const tabs=new Set<string>();
   for(const tab of node.tabs) {
    if(!isRecord(tab)||typeof tab.id!=='string'||!tab.id||tabs.has(tab.id)) throw new Error('Invalid workspace tab');
    tabs.add(tab.id);
    if(tab.kind==='session') { if(typeof tab.sessionId!=='string'||!tab.sessionId) throw new Error('Invalid session tab'); }
    else if(['file','diff','preview'].includes(String(tab.kind))) { if(typeof tab.projectId!=='string'||!tab.projectId||typeof tab.path!=='string'||!tab.path) throw new Error('Invalid file tab'); }
    else throw new Error('Invalid tab kind');
   }
   if(node.activeTabId!==null&&!tabs.has(String(node.activeTabId))) throw new Error('Invalid active tab');
  } else throw new Error('Invalid layout kind');
 }
 visit(value,0);
}
export function isRuntimeEvent(value:unknown):value is RuntimeEvent { return isRecord(value)&&value.v===1&&typeof value.event==='string'&&typeof value.epoch==='string'&&Number.isSafeInteger(value.seq)&&'data' in value; }
declare global { interface Window { threadterm:ThreadTermBridge } }

// File paths below are relative to a runtime-registered project or worktree root.
export interface FileScope { projectId:string; worktreePath?:string }
export interface FileEntry { name:string; path:string; kind:'file'|'directory'|'symlink'; size?:number }
export interface FileDocument { path:string; content:string; fingerprint:string; readonly:boolean; size:number; modifiedAt:string }
export interface Draft { id:string; projectId:string; worktreePath?:string; path:string; content:string; baseFingerprint:string; revision:number; updatedAt:string }
export interface GitChange { path:string; originalPath?:string; indexStatus:string; worktreeStatus:string; untracked:boolean }
export interface GitStatus { branch:string|null; upstream:string|null; ahead:number; behind:number; changes:GitChange[] }
export interface GitDiff { path:string; staged:boolean; oldText:string; newText:string; binary:boolean; fingerprint:string }
export interface Worktree { id:string; projectId:string; path:string; branch:string|null; head:string; isMain:boolean; locked:boolean; missing:boolean; upstream?:string; lastCommit?:CommitSummary }
export type ContentRef = {id:string;kind:'session';sessionId:string}|{id:string;kind:'file'|'diff'|'preview';projectId:string;worktreePath?:string;path:string};
export type PaneLayout = {kind:'pane';id:string;tabs:ContentRef[];activeTabId:string|null}|{kind:'split';id:string;direction:'horizontal'|'vertical';ratio:number;first:PaneLayout;second:PaneLayout};
export interface WorkspaceSave { id?:string;name:string;projectId?:string;worktreePath?:string;layout:PaneLayout;expectedRevision:number;operationId:string }


export function protocolContractOf(value:unknown):number|undefined {
 if(!isRecord(value)||typeof value.contract!=='number'||!Number.isInteger(value.contract)) return undefined;
 return value.contract;
}
export function protocolIncompatibleReason(peer:unknown,role:'desktop'|'runtime'='desktop'):string|undefined {
 if(!isRecord(peer)) {
  return role==='desktop'
   ? 'The runtime did not identify its protocol. The existing runtime was left running.'
   : 'The desktop client did not identify its protocol. Running jobs were not stopped.';
 }
 if(peer.protocol!==undefined&&peer.protocol!==PROTOCOL_VERSION) {
  return role==='desktop'
   ? `This desktop speaks wire protocol ${PROTOCOL_VERSION}, but the runtime spoke ${String(peer.protocol)}. The existing runtime was left running.`
   : `This runtime speaks wire protocol ${PROTOCOL_VERSION}, but the desktop spoke ${String(peer.protocol)}. Running jobs were not stopped.`;
 }
 const contract=protocolContractOf(peer);
 if(contract===PROTOCOL_CONTRACT) return undefined;
 if(contract===undefined) {
  return role==='desktop'
   ? `This desktop requires runtime contract ${PROTOCOL_CONTRACT} for choice-based Chat approvals. The connected runtime is older and was left running. Update ThreadTerm, or quit the old runtime from the tray before retrying.`
   : `This runtime requires desktop contract ${PROTOCOL_CONTRACT} for choice-based Chat approvals. This client is older. Update the ThreadTerm desktop. Running jobs were not stopped.`;
 }
 return role==='desktop'
  ? `This desktop requires contract ${PROTOCOL_CONTRACT}, but the runtime uses ${contract}. The existing runtime was left running.`
  : `This runtime requires contract ${PROTOCOL_CONTRACT}, but the desktop uses ${contract}. Running jobs were not stopped.`;
}

export type WireRequest = { [M in Method]: { v:1; id:string; method:M; params:RequestParams<M> } }[Method];
export type WireSuccess = { [M in Method]: { v:1; id:string; method:M; result:RequestResult<M> } }[Method];

export interface DataStatus { root:string;database:{path:string;sizeBytes:number};counts:{projects:number;sessions:number;workspaces:number;presets:number;drafts:number;usageRecords:number} }
export interface ThemeTokens { background:string;surface:string;text:string;muted:string;accent:string;border:string }
export interface SettingsBundle { marker:'threadterm-v3-settings';version:1;exportedAt:string;settings:{theme?:'light'|'dark'|'system';language?:'zh-CN'|'en';shortcuts?:Record<string,string>;notifications?:Record<string,boolean>;customThemes?:Record<string,ThemeTokens>;themeSelection?:string;terminalCompatibility?:{aiCompletionHints:boolean}} }
export interface UsageRecord { source?:UsageSource;status?:SessionStatus;sessionId:string;provider:ProviderId;recordedAt:string;inputTokens?:number;outputTokens?:number;estimatedCost?:number;currency?:string;model?:string }
export type UsageSource = 'created'|'native-history'|'rerun';
export interface SessionLifecycleMetric { sessionId:string;projectId?:string;provider:ProviderId;mode:SessionMode;status:SessionStatus;source?:UsageSource;sourceSessionId?:string;startedAt:string;endedAt?:string;sessionLifetimeSeconds?:number;durationKind:'session_lifetime';history:{status:SessionStatus;recordedAt:string}[] }
export interface UsageResult { records:UsageRecord[];sessions?:SessionLifecycleMetric[];summary?:{sessionCount:number;runningCount:number;endedCount:number;sessionLifetimeSeconds:number};pricing:'unknown'|'estimated' }
