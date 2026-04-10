import { useTranslation } from 'react-i18next';

interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  icon: string;
  title: string;
  context: string;
  entries: ShortcutEntry[];
}

export default function KeyboardShortcutsSettings() {
  const { t } = useTranslation('common');

  const sections: ShortcutSection[] = [
    {
      icon: '🌐',
      title: t('shortcuts.contextGlobal', 'Global'),
      context: t('shortcuts.contextGlobalDesc', 'Works everywhere'),
      entries: [
        { keys: ['⌘', 'N'], label: t('shortcuts.newSession', 'New session') },
        { keys: ['⌘', 'B'], label: t('shortcuts.toggleSidebar', 'Toggle sidebar panels') },
        { keys: ['⌘', ','], label: t('shortcuts.openSettings', 'Open settings') },
        { keys: ['⌘', '/'], label: t('shortcuts.toggleShortcuts', 'Toggle this shortcuts panel') },
        { keys: ['?'], label: t('shortcuts.showHelp', 'Show shortcuts help') },
        { keys: ['⌘', '1–9'], label: t('shortcuts.jumpToSession', 'Jump to session by position') },
      ],
    },
    {
      icon: '💬',
      title: t('shortcuts.contextChat', 'Chat / Session'),
      context: t('shortcuts.contextChatDesc', 'Active in chat focus'),
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
      context: t('shortcuts.contextLiveGridDesc', 'Card stream view'),
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
      context: t('shortcuts.contextTerminalDesc', 'Active in terminal'),
      entries: [
        { keys: ['Ctrl', 'C'], label: t('shortcuts.interruptCommand', 'Interrupt running command') },
        { keys: ['Ctrl', 'L'], label: t('shortcuts.clearTerminal', 'Clear terminal') },
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
            <div className="mb-3 flex items-center gap-2">
              <span className="text-sm" role="img" aria-hidden="true">{section.icon}</span>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
                {section.title}
              </h4>
              <span className="rounded-full bg-muted/80 px-2 py-0.5 text-[10px] text-muted-foreground">
                {section.context}
              </span>
            </div>
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
