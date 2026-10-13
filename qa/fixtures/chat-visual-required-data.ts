import type { ChatItem, ChatQueue, Session } from '@threadterm/protocol';
import type { ContextItem } from '../../renderer/src/chatContext';

export const requiredSurfaceSession: Session = { id: 'visual-required-surfaces', provider: 'grok', mode: 'chat', status: 'idle', title: 'Required Chat surfaces', createdAt: 'now', updatedAt: 'now' };
const turnId = 'visual-required-turn';
export const requiredSurfaceItems: ChatItem[] = [
  { id: 'user', role: 'user', turnId, createdAt: 'now', parts: [{ type: 'text', text: 'Show every required visual surface.' }] },
  { id: 'approval', role: 'assistant', turnId, createdAt: 'now', parts: [{ type: 'approval', approvalId: 'approval-required', status: 'pending', data: { approvalId: 'approval-required', title: 'Run the fixture command?', choices: [{ choiceId: 'allow', label: 'Allow once', kind: 'allow', scope: 'once' }, { choiceId: 'deny', label: 'Deny', kind: 'deny', scope: 'once' }] } }] },
  { id: 'question', role: 'assistant', turnId, createdAt: 'now', parts: [{ type: 'approval', approvalId: 'question-required', status: 'pending', data: { approvalId: 'question-required', interaction: 'question', answerable: true, form: { kind: 'questions', questions: [{ id: 'priority', header: 'Priority', question: 'Which priority should the fixture use?', options: [{ label: 'High', description: 'Run this check first.' }, { label: 'Normal', description: 'Run it with the normal queue.' }], multiSelect: false, allowOther: false }] } } }] },
  { id: 'network', role: 'assistant', turnId, createdAt: 'now', parts: [{ type: 'status', data: { kind: 'providerRetry', state: 'retrying', attempt: 2, maxRetries: 5 } }] },
  { id: 'usage', role: 'assistant', turnId, createdAt: 'now', parts: [{ type: 'text', status: 'complete', text: 'Weekly limit: 42% used', data: { kind: 'plan', rows: [{ label: 'Weekly limit', percent: 42, reset: 'resets in 1d' }] } }] },
  { id: 'subagent', role: 'assistant', turnId, createdAt: 'now', parts: [{ type: 'subagent', status: 'completed', data: { key: 'required-surfaces-child', provider: 'codex', agentType: 'explore', description: 'Inspect the required card', status: 'completed', transcript: 'none', toolCount: 2, summary: 'The fixture has the required surfaces.', startedAt: '2026-10-12T00:00:00.000Z', endedAt: '2026-10-12T00:00:01.000Z' } }] },
  { id: 'answer', role: 'assistant', turnId, createdAt: 'now', elapsedMs: 1200, parts: [{ type: 'text', text: 'Required visual surfaces are ready.' }] },
];
export const requiredSurfaceQueue: ChatQueue = { sessionId: requiredSurfaceSession.id, paused: false, items: [{ id: 'queued-required', text: 'Run after the fixture turn.', images: [], revision: 1, state: 'queued', createdAt: 'now', updatedAt: 'now' }] };
export const requiredSurfaceContext: ContextItem[] = [{ kind: 'file', id: 'required-context', path: 'src/required.ts', startLine: 1, endLine: 2 }];
