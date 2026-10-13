import assert from 'node:assert/strict';
import test from 'node:test';
import { askSelectionChat } from './askSelectionChat';
import type { Session } from '@threadterm/protocol';
const source: Session = { id: 'source', title: 'Source', provider: 'codex', mode: 'chat', status: 'idle', createdAt: '', updatedAt: '' };
const created: Session = { ...source, id: 'created' };
function fixture() {
  const actions: string[] = [];
  const api = { config: async () => ({ cwd: '/fixture' }), create: async () => { actions.push('create'); return created; }, save: () => { actions.push('save'); }, focus: () => { actions.push('focus'); }, cancelFocus: () => { actions.push('cancelFocus'); }, discard: async () => { actions.push('discard'); } };
  return { actions, api };
}
test('Ask saves a quote and requests composer focus before opening, without sending', async () => {
  const { api, actions } = fixture(); await askSelectionChat(source, 'quote', () => true, () => { actions.push('open'); }, api);
  assert.deepEqual(actions, ['create', 'save', 'focus', 'open']);
});
test('cancel during create cleans the exact new chat, with no quote/open/focus left pending', async () => {
  const { api, actions } = fixture(); let current = true;
  api.create = async () => { actions.push('create'); current = false; return created; };
  await askSelectionChat(source, 'quote', () => current, () => { actions.push('open'); }, api);
  assert.deepEqual(actions, ['create', 'cancelFocus', 'discard']);
});
test('storage failure cleans the new chat, and cancellation before create creates nothing', async () => {
  const { api, actions } = fixture(); api.save = () => { throw new Error('storage full'); };
  await assert.rejects(askSelectionChat(source, 'quote', () => true, () => {}, api), /storage full/);
  assert.deepEqual(actions, ['create', 'cancelFocus', 'discard']);
  actions.length = 0; await askSelectionChat(source, 'quote', () => false, () => {}, api); assert.deepEqual(actions, []);
});
