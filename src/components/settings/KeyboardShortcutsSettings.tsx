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
      icon: 'O',
      title: t('shortcuts.contextGlobal', 'Global'),
      context: t('shortcuts.contextGlobalDesc', 'Registered by the desktop app'),
      entries: [
        { keys: ['⌘/Ctrl', '⇧', 'Space'], label: t('shortcuts.globalSelector', 'Open pinned-session selector') },
        { keys: ['⌘/Ctrl', '⇧', 'O'], label: t('shortcuts.recycleFloat', 'Recycle floating terminal to main window') },
      ],
    },
    {
      icon: 'G',
      title: t('shortcuts.contextGrid', 'Terminal Manager'),
      context: t('shortcuts.contextGridDesc', 'Active in the main window'),
      entries: [
        { keys: ['⌘/Ctrl', 'N'], label: t('shortcuts.newTerminal', 'Create terminal') },
        { keys: ['⌘/Ctrl', '`'], label: t('shortcuts.inlineSelector', 'Toggle inline selector') },
        { keys: ['⌘/Ctrl', 'Tab'], label: t('shortcuts.nextCard', 'Next terminal card') },
        { keys: ['⌘/Ctrl', '⇧', 'Tab'], label: t('shortcuts.previousCard', 'Previous terminal card') },
        { keys: ['⌘/Ctrl', '1–9'], label: t('shortcuts.jumpToSession', 'Jump to card by position') },
        { keys: ['⌘/Ctrl', 'B'], label: t('shortcuts.notificationCenter', 'Toggle notification center') },
        { keys: ['⌘/Ctrl', ','], label: t('shortcuts.openSettings', 'Open settings') },
        { keys: ['⌘/Ctrl', '⇧', 'M'], label: t('shortcuts.backToGrid', 'Return focused terminal to grid') },
      ],
    },
    {
      icon: 'S',
      title: t('shortcuts.contextSelector', 'Selector'),
      context: t('shortcuts.contextSelectorDesc', 'Active while the selector is open'),
      entries: [
        { keys: ['← → ↑ ↓'], label: t('shortcuts.navigateCards', 'Navigate cards') },
        { keys: ['Enter'], label: t('shortcuts.openFloating', 'Open selected card in floating terminal') },
        { keys: ['1–9'], label: t('shortcuts.jumpToSession', 'Jump to card by position') },
        { keys: ['M'], label: t('shortcuts.switchSelectorMode', 'Switch tile/carousel mode') },
        { keys: ['Esc'], label: t('shortcuts.closeOverlay', 'Close selector') },
      ],
    },
    {
      icon: 'T',
      title: t('shortcuts.contextTerminal', 'Terminal'),
      context: t('shortcuts.contextTerminalDesc', 'Active in terminal'),
      entries: [
        { keys: ['Ctrl', 'C'], label: t('shortcuts.interruptCommand', 'Interrupt running command') },
        { keys: ['Ctrl', 'L'], label: t('shortcuts.clearTerminal', 'Clear terminal') },
        { keys: ['⌘/Ctrl', 'V'], label: t('shortcuts.pasteClipboard', 'Paste clipboard') },
        { keys: ['Esc'], label: t('shortcuts.escapeToCli', 'Send Escape to the CLI') },
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
            className="rounded-xl border border-border/60 bg-card/72 p-4 shadow-sm"
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
