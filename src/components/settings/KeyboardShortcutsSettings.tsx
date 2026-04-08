import { useTranslation } from 'react-i18next';

interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  entries: ShortcutEntry[];
}

export default function KeyboardShortcutsSettings() {
  const { t } = useTranslation('common');

  const sections: ShortcutSection[] = [
    {
      title: t('shortcuts.navigation', 'Navigation'),
      entries: [
        { keys: ['⌘', '['], label: t('shortcuts.prevSession', 'Previous session') },
        { keys: ['⌘', ']'], label: t('shortcuts.nextSession', 'Next session') },
        { keys: ['⌘', '1–9'], label: t('shortcuts.jumpToSession', 'Jump to session by position') },
        { keys: ['⌘', 'N'], label: t('shortcuts.newSession', 'New session') },
      ],
    },
    {
      title: t('shortcutsSettings.interface', 'Interface'),
      entries: [
        { keys: ['⌘', 'B'], label: t('shortcuts.toggleSidebar', 'Toggle sidebar panels') },
        { keys: ['⌘', ','], label: t('shortcuts.openSettings', 'Open settings') },
        { keys: ['⌘', '/'], label: t('shortcuts.toggleShortcuts', 'Toggle this shortcuts panel') },
        { keys: ['?'], label: t('shortcuts.showHelp', 'Show shortcuts help') },
      ],
    },
    {
      title: t('shortcuts.session', 'Session'),
      entries: [
        { keys: ['⌘', 'K'], label: t('shortcuts.cmdPalette', 'Open command palette') },
        { keys: ['⌘', 'F'], label: t('shortcuts.fullscreen', 'Toggle fullscreen') },
        { keys: ['Esc'], label: t('shortcuts.closeOverlay', 'Close overlay / modal') },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          {t('shortcuts.title', 'Keyboard Shortcuts')}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('shortcutsSettings.platformNote', '⌘ = Cmd (Mac) / Ctrl (Windows/Linux)')}
        </p>
      </div>

      <div className="space-y-6">
        {sections.map((section) => (
          <div
            key={section.title}
            className="rounded-2xl border border-border/60 bg-card/72 p-4 shadow-sm"
          >
            <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h4>
            <div className="divide-y divide-border/40">
              {section.entries.map((entry) => (
                <div
                  key={entry.label}
                  className="flex items-center justify-between py-2.5 text-sm"
                >
                  <span className="text-foreground">{entry.label}</span>
                  <div className="flex items-center gap-1">
                    {entry.keys.map((key) => (
                      <kbd
                        key={key}
                        className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-md border border-border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground"
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
  );
}
