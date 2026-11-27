/*
 * "Open in" (owner 2026-11-26, after T3 Code's Open-in picker): the editors and terminal installed on this PC, the one
 * the user picked last, and the request that opens a project, a branch or a file at its line. Main finds the
 * programs and checks every path (desktop/src/openInEditor.ts).
 */
import { useSyncExternalStore } from 'react';
import { openIn, openInEditors } from './bridge';
import { notify } from './notices';
import { userErrorText } from './runtimeError';

export interface OpenInEditor { id: string; label: string; icon?: string }
export interface OpenInTarget { projectId: string; worktreePath?: string; path?: string; line?: number }

const PREFERRED_KEY = 'threadterm.openIn.preferred';
let editors: readonly OpenInEditor[] = [];
let loading: Promise<void> | undefined;
let preferredId = (() => { try { return localStorage.getItem(PREFERRED_KEY) ?? undefined; } catch { return undefined; } })();
const listeners = new Set<() => void>();
let snapshot = { editors, preferredId };
const publish = () => { snapshot = { editors, preferredId }; for (const listener of listeners) listener(); };

/** Asks main once per window (again with `refresh`, after installing an editor). */
export function loadEditors(refresh = false): Promise<void> {
  if (loading && !refresh) return loading;
  loading = openInEditors(refresh).then(rows => { editors = rows; publish(); }, () => { editors = []; publish(); });
  return loading;
}

/** The last editor used, if it is still installed; else the first one found. */
export function preferredEditor(list: readonly OpenInEditor[], id: string | undefined): OpenInEditor | undefined {
  return list.find(editor => editor.id === id) ?? list.find(editor => editor.id !== 'terminal') ?? list[0];
}

export function useOpenInEditors(): { editors: readonly OpenInEditor[]; preferred?: OpenInEditor } {
  const current = useSyncExternalStore(listener => { listeners.add(listener); void loadEditors(); return () => { listeners.delete(listener); }; }, () => snapshot, () => snapshot);
  return { editors: current.editors, preferred: preferredEditor(current.editors, current.preferredId) };
}

/** "在 VS Code 中打开" / "Open in VS Code"; the terminal says what it does. */
export function openInLabel(editor: Pick<OpenInEditor, 'id' | 'label'>, zh: boolean): string {
  if (editor.id === 'terminal') return zh ? '在终端中打开' : 'Open in Terminal';
  return zh ? `在 ${editor.label} 中打开` : `Open in ${editor.label}`;
}

/** Opens the target and remembers the editor (the terminal is never remembered as the editor). */
export async function openInEditor(editor: OpenInEditor, target: OpenInTarget, zh: boolean): Promise<void> {
  try {
    await openIn({ editorId: editor.id, ...target });
    if (editor.id !== 'terminal' && editor.id !== preferredId) {
      preferredId = editor.id;
      try { localStorage.setItem(PREFERRED_KEY, editor.id); } catch { /* private storage off: still works this session */ }
      publish();
    }
  } catch (error) {
    notify({ key: 'open-in', tone: 'error', text: userErrorText(error, zh ? `无法在 ${editor.label} 中打开。` : `Could not open in ${editor.label}.`, zh) });
  }
}
