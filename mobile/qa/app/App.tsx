// Test-only Expo entrypoint. It injects a deterministic NativePort into the real CompanionApp.
import React from 'react';
import type { Session, ChatApprovalData, ChatUiState, RequestMap } from '@threadterm/protocol';
import type { MobileSnapshot } from '@threadterm/protocol/mobile';
import type { NativePort } from '../../src/core/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CompanionProvider } from '../../src/core/react';
import { createCompanion } from '../../src/core/controller';
import { CompanionApp } from '../../App';

const calls: {id:string;method:string;params:Record<string,unknown>}[] = [];
Object.defineProperty(globalThis, '__TT_MOBILE_QA_CALLS__', { value: calls });
const now = '2026-11-06T00:00:00.000Z';
const machines = [
  { id: 'alpha', name: 'Control PC', color: '#4f59c8', transport: 'tls' as const, endpoint: '127.0.0.1:9000', tlsFingerprint: 'AA', permission: 'fullcontrol' as const, expiresAt: '2099-01-01T00:00:00.000Z' },
  { id: 'beta', name: 'Readonly PC', color: '#8c887f', transport: 'tls' as const, endpoint: '127.0.0.1:9001', tlsFingerprint: 'BB', permission: 'readonly' as const, expiresAt: '2099-01-01T00:00:00.000Z' },
];
const chat = (machineId: string, readOnly = false): Session => ({ id: 'same-chat', title: `Review ${machineId}`, projectId: 'same-project', worktreePath: `C:/${machineId}/project`, provider: 'codex', mode: 'chat', status: 'waiting', readOnly, createdAt: now, updatedAt: now, activity: { state: 'awaiting_input' as const, revision: 1, turnId: `turn-${machineId}` } });
const terminal: Session = { id: 'same-shell', title: 'Build terminal', projectId: 'same-project', worktreePath: 'C:/alpha/project', provider: 'codex', mode: 'terminal', status: 'running', readOnly: false, createdAt: now, updatedAt: now, activity: { state: 'running' as const, revision: 1, turnId: 'turn-shell' } };
const snapshot = (machine: typeof machines[number]): MobileSnapshot => ({
  epoch: `epoch-${machine.id}`, revision: 1, permission: machine.permission,
  capabilities: { contract: 1, methods: ['mobile.snapshot', 'mobile.events.subscribe', 'chat.snapshot', 'chat.options', 'chat.connection', 'terminal.read', 'filesystem.files', 'filesystem.read', 'git.status', 'git.diff', 'git.log', 'git.branches', 'session.claim', 'session.release', 'chat.answer', 'chat.approve', 'terminal.input', 'terminal.resize', ...(machine.id === 'alpha' ? ['chat.option.set'] : [])] },
  projects: [{ id: 'same-project', name: `Project ${machine.id}`, path: `C:/${machine.id}/project`, createdAt: now, revision: 1, pinned: false, sortOrder: 0, git: { available: true, branch: 'main' } }],
  worktrees: [], sessions: machine.id === 'alpha' ? [chat(machine.id), terminal] : [chat(machine.id, true)], inbox: [], providers: [],
});
const approval: ChatApprovalData = { approvalId: 'question-alpha', turnId: 'turn-alpha', title: 'Choose QA mode', interaction: 'question', choices: [], form: { kind: 'questions', questions: [{ id: 'mode', question: 'Which verification mode should run?', options: [{ label: 'Safe', description: 'Read-only fixture.' }, { label: 'Full', description: 'Exercise controls.' }], multiSelect: false, allowOther: false, secret: false }] } };
const chatSnapshot = (machineId: string): RequestMap['chat.snapshot'][1] => ({ items: [{ id: `request-${machineId}`, turnId: `turn-${machineId}`, role: 'assistant', createdAt: now, parts: [{ type: 'text', text: 'A response is needed before the session can continue.' }, { type: 'approval', approvalId: `question-${machineId}`, status: 'pending', data: machineId === 'alpha' ? approval : { ...approval, approvalId: 'question-beta', turnId: 'turn-beta', title: 'Readonly question' } }] }], revision: 1, repair: {offered:false,degraded:false}, hasEarlier: false });
const modelChoices = ['gpt-5.4','gpt-5.4-mini','gpt-5.3-codex','o4-mini'].map((value,index) => ({ value, name:value, group:index < 2 ? 'Recommended' : 'Other models', ...(index === 0 ? {recommended:true} : {}) }));
const optionUi = (machineId:string):ChatUiState => ({ options:[
  {id:'model',name:'Model',value:machineId === 'alpha' ? 'gpt-5.4' : 'gpt-5.4-mini',choices:modelChoices,category:'model'},
  {id:'thinking',name:'Thinking',value:'medium',choices:[{value:'low',name:'Low'},{value:'medium',name:'Medium',recommended:true},{value:'high',name:'High'}],category:'thinking'},
  {id:'mode',name:'Permission mode',value:'default',choices:[{value:'default',name:'Default'},{value:'plan',name:'Plan'}],category:'mode'},
  {id:'fast',name:'Fast mode',value:'false',choices:[{value:'false',name:'Off'},{value:'true',name:'On'}],kind:'boolean',category:'other'},
],commands:[],loadState:'ready',inputCapabilities:{} });
const optionStates = new Map(machines.map(machine => [machine.id,optionUi(machine.id)]));
const runtimeListeners = new Set<Parameters<NativePort['onRuntimeEvent']>[0]>();
const native: NativePort = {
  available: true, listMachines: async () => machines,
  connect: async (id: string) => { const m = machines.find(row => row.id === id)!; return { epoch: `epoch-${id}`, permission: m.permission }; }, disconnect: async () => {},
  request: async (id: string, method: string, text: string) => {
    const params = JSON.parse(text);calls.push({id,method,params});const machine = machines.find(row => row.id === id)!;
    const responses: Record<string, unknown> = {
      'mobile.events.subscribe': { sessionIds: params.sessionIds, revision: 1 }, 'mobile.snapshot': snapshot(machine), 'chat.snapshot': chatSnapshot(id),
      'chat.options': optionStates.get(id)!, 'chat.connection': { sessionId: params.sessionId, runtimeEpoch: `epoch-${id}`, connectionGeneration: 1, revision: 1, phase: 'ready', optionsLoadState: 'ready' },
      'terminal.read': { sessionId: params.sessionId, fromCursor: 0, nextCursor: 24, truncated: false, encoding: 'base64', data: 'cWEgc2hlbGwgYnVpbGQgcGFzc2VkCg==' },
      'filesystem.files': { paths: ['README.md', 'src/index.ts'], truncated: false }, 'filesystem.read': { path: params.path, content: `fixture file from ${id}`, fingerprint: 'fixture', readonly: true, size: 25, modifiedAt: now },
      'git.status': { branch: 'main', upstream: null, ahead: 0, behind: 0, changes: [{ path: 'src/index.ts', indexStatus: ' ', worktreeStatus: 'M', untracked:false }] }, 'git.diff': { path: params.path, staged:params.staged, fingerprint:'fixture', oldText: 'before', newText: 'after', binary: false },
      'git.log': { commits: [], hasMore:false }, 'git.branches': { current:'main', detached:false, branches: [{ name: 'main', current: true, remote:false }] }, 'session.claim': { leaseEpoch: 1 }, 'session.release': null, 'chat.answer': null, 'chat.approve': null, 'terminal.input': null, 'terminal.resize': null,
    };
    if(method === 'chat.option.set') {
      const current=optionStates.get(id)!;
      const options=current.options.map(option => option.id === params.optionId ? {...option,value:String(params.value)} : option);
      const updated={...current,options};optionStates.set(id,updated);return JSON.stringify(updated);
    }
    return JSON.stringify(responses[method] ?? null);
  },
  unlockControl: async () => true, lockControl: async () => {}, onRuntimeEvent: listener => { runtimeListeners.add(listener); return () => { runtimeListeners.delete(listener); }; }, onConnectionState: () => () => {}, onControlLock: () => () => {},
  preparePairing: async () => { throw Error('fixture_unavailable'); }, confirmPairing: async () => { throw Error('fixture_unavailable'); }, cancelPairing: async () => {}, removeMachine: async id => { const index = machines.findIndex(item => item.id === id); if (index >= 0) machines.splice(index, 1); }, renameMachine: async () => {}, openPreview: async () => {}, chooseAttachment: async () => null, readAttachment: async () => '',
};
const store = createCompanion(native, { getItem: async () => null, setItem: async () => {} }, () => 'qa');
Object.defineProperty(globalThis, '__TT_MOBILE_QA__', { value: {
  controller: store.controller,
  setPermission: (id: string, permission: 'readonly' | 'fullcontrol') => {
    const machine = machines.find(item => item.id === id)!; machine.permission = permission;
    const revision = Date.now();
    for (const listener of runtimeListeners) listener({machineId:id,eventJson:JSON.stringify({v:1,event:'mobile.changed',epoch:`epoch-${id}`,seq:revision,data:{permissionChanged:true}})});
  },
} });
export default function QaApp() { return <SafeAreaProvider><CompanionProvider store={store}><CompanionApp /></CompanionProvider></SafeAreaProvider>; }
