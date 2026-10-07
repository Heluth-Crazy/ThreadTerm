import { useContext } from 'react';
import type { Session } from '@threadterm/protocol';
import { ContextHost } from './ContextHost';
import { ContextSendAction } from './ContextSendAction';
import { request } from '../bridge';

export function TerminalContextAction({ session, selection, zh }: { session: Session | undefined; selection: () => string; zh: boolean }) {
  const host = useContext(ContextHost);
  return <ContextSendAction host={host} zh={zh} testId="terminal-selection-send-to-agent" item={async () => {
    const text = selection();
    if (!text) throw new Error(zh ? '请先选中终端输出。' : 'Select terminal output first.');
    const cwd = session ? (await request('session.config.read', { sessionId: session.id })).cwd : undefined;
    return { kind: 'terminal', id: crypto.randomUUID(), sessionTitle: session?.title ?? (zh ? '终端' : 'Terminal'), cwd, text, lines: text.split(/\r?\n/).length };
  }}/>;
}
