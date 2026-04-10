import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface KeyboardShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  icon: string;
  title: string;
  description: string;
  entries: ShortcutEntry[];
}

export default function KeyboardShortcutsOverlay({ open, onClose }: KeyboardShortcutsOverlayProps) {
  const { t } = useTranslation('common');

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const sections: ShortcutSection[] = [
    {
      icon: '🌐',
      title: t('shortcuts.contextGlobal', 'Global'),
      description: t('shortcuts.contextGlobalDesc', 'Works everywhere'),
      entries: [
        { keys: ['⌘', 'N'], label: t('shortcuts.newSession', 'New session') },
        { keys: ['⌘', 'B'], label: t('shortcuts.toggleSidebar', 'Toggle sidebar panels') },
        { keys: ['⌘', ','], label: t('shortcuts.openSettings', 'Open settings') },
        { keys: ['⌘', '/'], label: t('shortcuts.toggleShortcuts', 'Toggle this shortcuts panel') },
        { keys: ['?'], label: t('shortcuts.showHelp', 'Show this help') },
        { keys: ['⌘', '1–9'], label: t('shortcuts.jumpToSession', 'Jump to session by position') },
      ],
    },
    {
      icon: '💬',
      title: t('shortcuts.contextChat', 'Chat / Session'),
      description: t('shortcuts.contextChatDesc', 'Active in chat focus'),
      entries: [
        { keys: ['⌘', 'K'], label: t('shortcuts.cmdPalette', 'Open command palette') },
        { keys: ['⌘', 'F'], label: t('shortcuts.fullscreen', 'Toggle fullscreen') },
        { keys: ['⌘', '['], label: t('shortcuts.prevSession', 'Previous session') },
        { keys: ['⌘', ']'], label: t('shortcuts.nextSession', 'Next session') },
        { keys: ['⌘', '`'], label: t('shortcuts.cycleView', 'Cycle chat/split/terminal') },
        { keys: ['Enter'], label: t('shortcuts.sendMessage', 'Send message') },
        { keys: ['Shift', 'Enter'], label: t('shortcuts.newLine', 'New line in message') },
        { keys: ['Esc'], label: t('shortcuts.closeOverlay', 'Close overlay / modal') },
      ],
    },
    {
      icon: '▦',
      title: t('shortcuts.contextLiveGrid', 'LiveGrid'),
      description: t('shortcuts.contextLiveGridDesc', 'Card stream view'),
      entries: [
        { keys: ['← → ↑ ↓'], label: t('shortcuts.navigateCards', 'Navigate cards') },
        { keys: ['Enter', '␣'], label: t('shortcuts.expandCard', 'Expand focused card') },
        { keys: ['Esc'], label: t('shortcuts.collapseCard', 'Collapse / exit focus') },
        { keys: ['Tab'], label: t('shortcuts.focusNextCard', 'Focus next card') },
        { keys: ['Shift', 'Tab'], label: t('shortcuts.focusPrevCard', 'Focus previous card') },
      ],
    },
    {
      icon: '⚙',
      title: t('shortcuts.contextTerminal', 'Terminal'),
      description: t('shortcuts.contextTerminalDesc', 'Active in terminal'),
      entries: [
        { keys: ['Ctrl', 'C'], label: t('shortcuts.interruptCommand', 'Interrupt running command') },
        { keys: ['Ctrl', 'L'], label: t('shortcuts.clearTerminal', 'Clear terminal') },
      ],
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-foreground">
            {t('shortcuts.title', 'Keyboard Shortcuts')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {/* Platform note */}
        <p className="mb-4 text-[11px] text-muted-foreground">
          {t('shortcutsSettings.platformNote', '⌘ = Cmd (Mac) / Ctrl (Windows/Linux)')}
        </p>

        {/* Context-grouped sections */}
        <div className="space-y-5">
          {sections.map((section) => (
            <div key={section.title}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm" role="img" aria-hidden="true">{section.icon}</span>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
                  {section.title}
                </h3>
                <span className="rounded-full bg-muted/80 px-2 py-0.5 text-[10px] text-muted-foreground">
                  {section.description}
                </span>
              </div>
              <div className="space-y-1">
                {section.entries.map((entry) => (
                  <div key={entry.label} className="flex items-center justify-between py-1 text-sm">
                    <span className="text-muted-foreground">{entry.label}</span>
                    <div className="flex items-center gap-1">
                      {entry.keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
