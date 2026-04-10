import { useCallback, useEffect } from 'react';

interface GlobalShortcutsConfig {
  onToggleFullscreen: () => void;
  onPrevSession: () => void;
  onNextSession: () => void;
  onNewSession: () => void;
  onShowShortcuts: () => void;
  onNavigateSession: (index: number) => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
  onToggleShortcuts: () => void;
}

function isTextInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useGlobalKeyboardShortcuts(config: GlobalShortcutsConfig) {
  const {
    onToggleFullscreen,
    onPrevSession,
    onNextSession,
    onNewSession,
    onShowShortcuts,
    onNavigateSession,
    onOpenSettings,
    onToggleSidebar,
    onToggleShortcuts,
  } = config;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const inInput = isTextInput(e.target);

      // ⌘, → open settings
      if (mod && e.key === ',') {
        e.preventDefault();
        onOpenSettings();
        return;
      }

      // ⌘B → toggle sidebar (skip if in input)
      if (mod && e.key === 'b' && !inInput) {
        e.preventDefault();
        onToggleSidebar();
        return;
      }

      // ⌘/ → toggle keyboard shortcuts overlay
      if (mod && e.key === '/') {
        e.preventDefault();
        onToggleShortcuts();
        return;
      }

      // ⌘F → toggle fullscreen (skip if in input to allow native find)
      if (mod && e.key === 'f' && !inInput) {
        e.preventDefault();
        onToggleFullscreen();
        return;
      }

      // ⌘[ → prev session
      if (mod && e.key === '[') {
        e.preventDefault();
        onPrevSession();
        return;
      }

      // ⌘] → next session
      if (mod && e.key === ']') {
        e.preventDefault();
        onNextSession();
        return;
      }

      // ⌘N → new session
      if (mod && e.key === 'n' && !inInput) {
        e.preventDefault();
        onNewSession();
        return;
      }

      // ? → show shortcuts (only outside inputs)
      if (e.key === '?' && !mod && !inInput) {
        e.preventDefault();
        onShowShortcuts();
        return;
      }

      // ⌘1-⌘9 → jump to session by position
      if (mod && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        onNavigateSession(parseInt(e.key, 10) - 1);
        return;
      }
    },
    [onToggleFullscreen, onPrevSession, onNextSession, onNewSession, onShowShortcuts, onNavigateSession, onOpenSettings, onToggleSidebar, onToggleShortcuts],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
