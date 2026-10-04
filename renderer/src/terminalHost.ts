import type { IWindowsPty } from '@xterm/xterm';
import { request } from './bridge';

/**
 * From this ConPTY build on, xterm trusts the host's line-wrap information instead of guessing
 * ("a line ending in a non-space character continues"). The guess glued a full-width line to the next
 * one on resize; ThreadTerm's bundled OpenConsole reports wraps properly, the in-box ConPTY of older
 * Windows does not — reporting a modern build there broke long lines (qa/terminal-repro.mjs reflow,
 * 2026-10-03). So only the host the runtime actually uses decides.
 */
export const MODERN_CONPTY_BUILD = 21376;

export type ConptyHost = 'system' | 'bundled';

/** xterm's `windowsPty` for the OS-derived value and the runtime's console host. */
export function windowsPtyFor(os: IWindowsPty | undefined, host: ConptyHost | undefined): IWindowsPty | undefined {
  if (!os) return undefined;
  if (host === 'bundled') return { backend: 'conpty', buildNumber: Math.max(os.buildNumber ?? 0, MODERN_CONPTY_BUILD) };
  return os;
}

let known: Promise<ConptyHost | undefined> | undefined;

/** The runtime's console host, asked once; undefined when the runtime predates `terminal.host`. */
export function conptyHost(): Promise<ConptyHost | undefined> {
  known ??= request('terminal.host', {}).then(result => result.conptyHost, () => undefined);
  return known;
}
