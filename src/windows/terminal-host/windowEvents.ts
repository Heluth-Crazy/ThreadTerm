import type { EventCallback, EventName, UnlistenFn } from '@tauri-apps/api/event';

export interface WindowEventSource {
  listen<T>(event: EventName, handler: EventCallback<T>): Promise<UnlistenFn>;
}

/** Registers a listener against the current WebviewWindow target, never the global event bus. */
export function listenOnTerminalWindow<T>(
  source: WindowEventSource,
  event: EventName,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return source.listen(event, handler);
}
