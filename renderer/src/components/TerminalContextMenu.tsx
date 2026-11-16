import { useContext, useEffect } from 'react';
import type { RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { Session } from '@threadterm/protocol';
import { ContextHost } from './ContextHost';
import { sendContextToAgent } from './ContextSendAction';
import { showContextMenu } from './ContextMenu';
import { request } from '../bridge';
import { terminalContextMenuItems } from '../terminalContextMenuItems';
import { fileLocationMenuItem } from '../fileLocation';
import { referenceLocationTarget, selectedTerminalFileReference } from '../referenceLocation';
import { terminalFileReferenceAtCell } from './terminalFileLinks';

/** Keeps terminal pointer handling out of TerminalSurface, whose xterm lifecycle must stay isolated. */
export function useTerminalContextMenu(host: RefObject<HTMLElement | null>, terminal: RefObject<Terminal | undefined>, session: Session | undefined, zh: boolean): void {
  const context = useContext(ContextHost);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const menu = (event: MouseEvent) => {
      // Applications using terminal mouse reporting own a normal secondary click; Shift is xterm's conventional
      // explicit override for its own selection/context interaction.
      const mouseReporting = (terminal.current?.modes as { mouseTrackingMode?: string } | undefined)?.mouseTrackingMode;
      if (mouseReporting && mouseReporting !== 'none' && !event.shiftKey) return;
      event.preventDefault();
      const selection = terminal.current?.getSelection() ?? '';
      const copy = (en: string, cn: string) => zh ? cn : en;
      const screen = terminal.current?.element?.querySelector<HTMLElement>('.xterm-screen');
      const rect = screen?.getBoundingClientRect();
      // Keyboard menus use only the captured selection, not an arbitrary cell at the screen's center.
      const pointerInside = event.type === 'contextmenu' && rect && rect.width > 0 && rect.height > 0
        && event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom;
      const pointerReference = pointerInside && terminal.current ? terminalFileReferenceAtCell(terminal.current,
        Math.floor((event.clientX - rect.left) / rect.width * terminal.current.cols) + 1,
        terminal.current.buffer.active.viewportY + Math.floor((event.clientY - rect.top) / rect.height * terminal.current.rows) + 1) : undefined;
      const reference = pointerReference ?? selectedTerminalFileReference(selection);
      const location = reference && referenceLocationTarget(session?.id, reference);
      const fileAction = location ? { ...fileLocationMenuItem(location, zh), id: 'terminal-file-reveal', testId: 'terminal-file-reveal' } : undefined;
      showContextMenu({ x: event.clientX, y: event.clientY, restoreFocus: terminal.current?.textarea ?? element, items: terminalContextMenuItems({ zh, selection, fileAction, canPaste: !terminal.current?.options.disableStdin, canSend: Boolean(context?.attachContext),
        send: async () => {
          if (!selection || !context) return;
          const cwd = session ? request('session.config.read', { sessionId: session.id }).then(value => value.cwd) : undefined;
          await sendContextToAgent({ host: context, zh, context: { kind: 'terminal', id: crypto.randomUUID(), sessionTitle: session?.title ?? copy('Terminal','终端'), cwd: await cwd, text: selection, lines: selection.split(/\r?\n/).length } });
        }, copy: () => navigator.clipboard.writeText(selection), paste: async () => terminal.current?.paste(await navigator.clipboard.readText()), selectAll: () => terminal.current?.selectAll() })});
    };
    const key = (event: KeyboardEvent) => {
      if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      menu({ defaultPrevented: false, shiftKey: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, preventDefault: () => event.preventDefault() } as MouseEvent);
    };
    element.addEventListener('contextmenu', menu);
    element.addEventListener('keydown', key);
    return () => { element.removeEventListener('contextmenu', menu); element.removeEventListener('keydown', key); };
  }, [host, terminal, session, zh, context]);
}
