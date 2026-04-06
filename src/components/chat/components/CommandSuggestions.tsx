import { useTranslation } from 'react-i18next';
import { useEffect, useRef } from 'react';
import type { SessionProvider } from '../../../types/app';

export const SLASH_COMMANDS: Record<string, { cmd: string; description: string; descriptionKey: string }[]> = {
  claude: [
    { cmd: '/clear', description: 'Clear conversation history', descriptionKey: 'commands.clear' },
    { cmd: '/compact', description: 'Compact & summarize conversation', descriptionKey: 'commands.compact' },
    { cmd: '/help', description: 'Show Claude Code help', descriptionKey: 'commands.help' },
    { cmd: '/status', description: 'Show current status', descriptionKey: 'commands.status' },
    { cmd: '/exit', description: 'End this session', descriptionKey: 'commands.exit' },
  ],
  codex: [
    { cmd: '/clear', description: 'Clear conversation history', descriptionKey: 'commands.clear' },
    { cmd: '/help', description: 'Show Codex help', descriptionKey: 'commands.help' },
    { cmd: '/exit', description: 'End this session', descriptionKey: 'commands.exit' },
  ],
  cursor: [
    { cmd: '/clear', description: 'Clear conversation history', descriptionKey: 'commands.clear' },
    { cmd: '/help', description: 'Show Cursor help', descriptionKey: 'commands.help' },
  ],
};

type CommandSuggestionsProps = {
  provider: SessionProvider;
  query: string;
  onSelect: (cmd: string) => void;
  onClose: () => void;
  activeIndex: number;
};

export default function CommandSuggestions({
  provider,
  query,
  onSelect,
  onClose: _onClose,
  activeIndex,
}: CommandSuggestionsProps) {
  const { t } = useTranslation('chat');
  const listRef = useRef<HTMLDivElement>(null);

  const commands = SLASH_COMMANDS[provider] ?? SLASH_COMMANDS.claude;
  const filtered = commands.filter((c) =>
    c.cmd.toLowerCase().startsWith(`/${query.toLowerCase()}`),
  );

  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.children[activeIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full mb-2 left-0 right-0 max-h-56 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg py-1 z-30"
    >
      <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t('commands.title', 'Commands')}
      </div>
      {filtered.map((cmd, index) => (
        <button
          key={cmd.cmd}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd.cmd);
          }}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer w-full text-left ${
            index === activeIndex ? 'bg-accent' : 'hover:bg-accent/50'
          }`}
        >
          <span className="font-mono text-foreground">{cmd.cmd}</span>
          <span className="text-muted-foreground">
            {t(cmd.descriptionKey, cmd.description)}
          </span>
        </button>
      ))}
    </div>
  );
}
