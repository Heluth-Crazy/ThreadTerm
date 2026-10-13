import { useEffect, useRef, useState } from 'react';
import { normalizeContextItems, serializeContext, type ContextItem } from './chatContext';
import { contextError } from './contextErrors';
import { copiedConversationItem, encodeCopiedConversationDraft } from './chatForkDraft';

const keyFor = (sessionId: string) => `threadterm.compose.context.${sessionId}`;
function load(sessionId: string): ContextItem[] {
  const saved = localStorage.getItem(keyFor(sessionId));
  if (!saved) return [];
  // JSON escaping costs more than the wire text, but corrupt storage must stay bounded too.
  if (saved.length > 512 * 1024) throw new Error('Context draft exceeds 128 KiB.');
  const value: unknown = JSON.parse(saved);
  if (!Array.isArray(value)) throw new Error('Invalid context draft.');
  const items = normalizeContextItems(value);
  serializeContext(items, '');
  return items;
}

export function useChatContext(sessionId: string, zh: boolean, onIssue: (message: string) => void) {
  const [state, setState] = useState<{ sessionId: string; items: ContextItem[] }>({ sessionId, items: [] });
  const current = useRef(state);
  const options = useRef({ zh, onIssue }); options.current = { zh, onIssue };
  useEffect(() => {
    let items: ContextItem[] = [];
    try { items = load(sessionId); }
    catch (error) { options.current.onIssue(contextError(error, options.current.zh)); }
    current.current = { sessionId, items }; setState(current.current);
  }, [sessionId]);
  const update = (items: ContextItem[]) => {
    const id = current.current.sessionId;
    const bounded = normalizeContextItems(items);
    serializeContext(bounded, '');
    // A storage failure leaves the recoverable draft intact and fails the attachment.
    if (bounded.length) localStorage.setItem(keyFor(id), JSON.stringify(bounded));
    else localStorage.removeItem(keyFor(id));
    current.current = { sessionId: id, items: bounded }; setState(current.current);
  };
  const attach = (item: ContextItem) => {
    if (current.current.sessionId !== sessionId) return false;
    try { update([...current.current.items, item]); return true; }
    catch (error) { throw new Error(contextError(error, options.current.zh)); }
  };
  const attachRef = useRef(attach); attachRef.current = attach;
  return {
    items: state.sessionId === sessionId ? state.items : [],
    attach: (item: ContextItem) => attachRef.current(item),
    serialize: (text: string) => serializeContext(current.current.sessionId === sessionId ? current.current.items : [], text),
    persistedDraft: (text: string) => encodeCopiedConversationDraft(current.current.sessionId === sessionId ? current.current.items : [], text),
    remove: (id: string) => { try { update(current.current.items.filter(item => item.id !== id)); } catch (error) { onIssue(contextError(error, zh)); } },
    clear: () => {
      try { update([]); }
      catch { current.current = { sessionId, items: [] }; setState(current.current); onIssue(zh ? '消息已接受，但本地上下文草稿未能清除。' : 'Message accepted, but the local context draft could not be cleared.'); }
    },
    restoreCopiedConversation: (draft: string) => {
      const item = copiedConversationItem(draft);
      if (!item || current.current.sessionId !== sessionId) return false;
      if (current.current.items.some(existing => existing.id === item.id || existing.kind === 'conversation')) return true;
      let items: ContextItem[];
      try { items = normalizeContextItems([...current.current.items, item]); serializeContext(items, ''); }
      catch (error) { onIssue(contextError(error, zh)); return false; }
      try { update(items); return true; }
      catch (error) { current.current = { sessionId, items }; setState(current.current); onIssue(contextError(error, zh)); return true; }
    },
  };
}
