import { describe, expect, it, vi } from 'vitest';
import type { EventCallback, EventName, UnlistenFn } from '@tauri-apps/api/event';
import { listenOnTerminalWindow, type WindowEventSource } from './windowEvents';

describe('terminal-host scoped event registration', () => {
  it('registers on the supplied WebviewWindow event target', async () => {
    const unlisten = vi.fn();
    const listen = vi.fn(async () => unlisten) as unknown as WindowEventSource['listen'];
    const source: WindowEventSource = { listen };
    const handler: EventCallback<{ revision: number }> = vi.fn();

    const result: UnlistenFn = await listenOnTerminalWindow(
      source,
      'terminal-host-bootstrap' as EventName,
      handler,
    );

    expect(listen).toHaveBeenCalledWith('terminal-host-bootstrap', handler);
    expect(result).toBe(unlisten);
  });
});
