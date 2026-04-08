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
  title: string;
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
      title: t('shortcuts.navigation', 'Navigation'),
      entries: [
        { keys: ['⌘', 'K'], label: t('shortcuts.cmdPalette', 'Open command palette') },
        { keys: ['⌘', ','], label: t('shortcuts.openSettings', 'Open settings') },
        { keys: ['⌘', '['], label: t('shortcuts.prevSession', 'Previous session') },
        { keys: ['⌘', ']'], label: t('shortcuts.nextSession', 'Next session') },
        { keys: ['⌘', 'N'], label: t('shortcuts.newSession', 'New session') },
        { keys: ['⌘', '1–9'], label: t('shortcuts.jumpToSession', 'Jump to session by position') },
      ],
    },
    {
      title: t('shortcuts.view', 'View'),
      entries: [
        { keys: ['⌘', 'F'], label: t('shortcuts.fullscreen', 'Toggle fullscreen') },
        { keys: ['⌘', 'B'], label: t('shortcuts.toggleSidebar', 'Toggle sidebar panels') },
        { keys: ['⌘', '/'], label: t('shortcuts.toggleShortcuts', 'Toggle this shortcuts panel') },
        { keys: ['?'], label: t('shortcuts.showHelp', 'Show this help') },
        { keys: ['Esc'], label: t('shortcuts.closeOverlay', 'Close overlay / modal') },
      ],
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[480px] rounded-2xl border border-border bg-card p-6 shadow-xl"
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
          ⌘ = Cmd (Mac) / Ctrl (Windows/Linux)
        </p>

        {/* Sections */}
        <div className="space-y-5">
          {sections.map((section) => (
            <div key={section.title}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </h3>
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
