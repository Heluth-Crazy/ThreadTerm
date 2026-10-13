import type { Session } from '@threadterm/protocol';
import { operationId, request } from './bridge';
import { clearChatContextDraft, saveChatContextDraft } from './useChatContext';
import { cancelChatInputFocus, requestChatInputFocus } from './terminalInputTargets';
type Services = { config: (id: string) => Promise<{ cwd: string }>; create: (source: Session, cwd: string) => Promise<Session>; save: (created: Session, source: Session, text: string) => void; discard: (created: Session) => Promise<void>; focus: (id: string) => void; cancelFocus: (id: string) => void };
const services: Services = {
  config: id => request('session.config.read', { sessionId: id }),
  create: (source, cwd) => request('session.create', { provider: source.provider, cwd, projectId: source.projectId, mode: 'chat', operationId: operationId() }),
  save: (created, source, text) => saveChatContextDraft(created.id, [{ kind: 'quote', id: operationId(), sourceTitle: source.title.replace(/[\r\n]/g, ' ').slice(0, 4096) || 'Reply', text }]),
  discard: async created => {
    try { clearChatContextDraft(created.id); } catch { /* Runtime retirement must still run if storage is unavailable. */ }
    await request('session.stop', { sessionId: created.id, operationId: operationId() });
    await request('catalog.visibility.update', { kind: 'session', id: created.id, visibility: 'removed', expectedRevision: created.organizationRevision ?? 0, operationId: operationId() });
  },
  focus: requestChatInputFocus, cancelFocus: cancelChatInputFocus,
};
/** One click owns exactly one new chat; cancelled/failed handoffs retire that exact empty chat. */
export async function askSelectionChat(source: Session, text: string, current: () => boolean, open: (id: string) => void, api: Services = services) {
  if (new TextEncoder().encode(text).length > 32 * 1024) throw new Error('Select at most 32 KiB of text. / 所选文本不能超过 32 KiB。');
  const config = await api.config(source.id);
  if (!current()) return;
  const created = await api.create(source, config.cwd);
  let handedOff = false;
  try {
    if (!current()) return;
    api.save(created, source, text); api.focus(created.id); open(created.id); handedOff = true;
  } finally {
    if (!handedOff) { api.cancelFocus(created.id); await api.discard(created); }
  }
}
