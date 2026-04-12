import { useTranslation } from 'react-i18next';
import { useEffect, useRef } from 'react';
import type { SessionProvider } from '../../../types/app';
import type { CustomSlashCommand } from '../../../types/slashCommands';
import type { DiscoveredCommand } from '../../../lib/tauri-bridge';
import { useCustomSlashCommands } from '../../../hooks/useCustomSlashCommands';

export type CommandEntry = {
  cmd: string;
  description: string;
  descriptionKey: string;
  category?: string;
  isCustom?: boolean;
  isDiscovered?: boolean;
  scope?: 'user' | 'project';
  prompt?: string;
};

export const SLASH_COMMANDS: Record<string, CommandEntry[]> = {
  claude: [
    // Conversation
    { cmd: '/clear', description: 'Clear conversation history', descriptionKey: 'commands.clear', category: 'conversation' },
    { cmd: '/compact', description: 'Compact & summarize conversation', descriptionKey: 'commands.compact', category: 'conversation' },

    // Project
    { cmd: '/init', description: 'Initialize project with CLAUDE.md', descriptionKey: 'commands.init', category: 'project' },
    { cmd: '/add-dir', description: 'Add additional working directory', descriptionKey: 'commands.addDir', category: 'project' },
    { cmd: '/memory', description: 'Edit CLAUDE.md memory files', descriptionKey: 'commands.memory', category: 'project' },

    // Code & Review
    { cmd: '/review', description: 'Request code review', descriptionKey: 'commands.review', category: 'code' },
    { cmd: '/pr-comments', description: 'Pull request comments', descriptionKey: 'commands.prComments', category: 'code' },

    // Config & Tools
    { cmd: '/model', description: 'Select or change AI model', descriptionKey: 'commands.model', category: 'config' },
    { cmd: '/config', description: 'View or set configuration', descriptionKey: 'commands.config', category: 'config' },
    { cmd: '/mcp', description: 'Manage MCP servers', descriptionKey: 'commands.mcp', category: 'config' },
    { cmd: '/vim', description: 'Toggle vim keybindings', descriptionKey: 'commands.vim', category: 'config' },

    // Info & Help
    { cmd: '/help', description: 'Show Claude Code help', descriptionKey: 'commands.help', category: 'info' },
    { cmd: '/status', description: 'Show current status', descriptionKey: 'commands.status', category: 'info' },
    { cmd: '/doctor', description: 'Check Claude Code health', descriptionKey: 'commands.doctor', category: 'info' },
    { cmd: '/release-notes', description: 'View recent release notes', descriptionKey: 'commands.releaseNotes', category: 'info' },
    { cmd: '/bug', description: 'Report a bug to Anthropic', descriptionKey: 'commands.bug', category: 'info' },

    // Session
    { cmd: '/exit', description: 'End this session', descriptionKey: 'commands.exit', category: 'session' },
    { cmd: '/logout', description: 'Log out of Claude', descriptionKey: 'commands.logout', category: 'session' },
    { cmd: '/login', description: 'Log in to Claude', descriptionKey: 'commands.login', category: 'session' },
    { cmd: '/terminal-setup', description: 'Configure terminal integration', descriptionKey: 'commands.terminalSetup', category: 'session' },
  ],
  codex: [
    { cmd: '/clear', description: 'Clear conversation history', descriptionKey: 'commands.clear' },
    { cmd: '/help', description: 'Show Codex help', descriptionKey: 'commands.help' },
    { cmd: '/exit', description: 'End this session', descriptionKey: 'commands.exit' },
    { cmd: '/diff', description: 'Show pending file changes', descriptionKey: 'commands.diff' },
    { cmd: '/approve', description: 'Approve pending changes', descriptionKey: 'commands.approve' },
  ],
  cursor: [
    { cmd: '/clear', description: 'Clear conversation history', descriptionKey: 'commands.clear' },
    { cmd: '/help', description: 'Show Cursor help', descriptionKey: 'commands.help' },
    { cmd: '/new', description: 'Start a new chat', descriptionKey: 'commands.new' },
  ],
};

/** Build full command list including custom and discovered commands for a given provider. */
export function buildCommandList(
  provider: string,
  customCommands: CustomSlashCommand[],
  discoveredCommands: DiscoveredCommand[] = [],
): CommandEntry[] {
  const builtIn = SLASH_COMMANDS[provider] ?? SLASH_COMMANDS.claude;

  // Convert discovered commands (CLI file-based) — only for claude
  const discovered: CommandEntry[] =
    provider === 'claude'
      ? discoveredCommands.map((c) => ({
          cmd: `/${c.name}`,
          description: c.description || c.name,
          descriptionKey: '',
          category: c.scope === 'project' ? 'cli-project' : 'cli-user',
          isDiscovered: true,
          scope: c.scope as 'user' | 'project',
        }))
      : [];

  const custom: CommandEntry[] = customCommands
    .filter((c) => c.provider === 'all' || c.provider === provider)
    .map((c) => ({
      cmd: `/${c.name}`,
      description: c.description || c.prompt.slice(0, 60),
      descriptionKey: '',
      category: 'custom',
      isCustom: true,
      prompt: c.prompt,
    }));

  // Built-in commands always take precedence
  const builtInNames = new Set(builtIn.map((c) => c.cmd));
  const filteredDiscovered = discovered.filter((c) => !builtInNames.has(c.cmd));

  return [...builtIn, ...filteredDiscovered, ...custom];
}

type CommandSuggestionsProps = {
  provider: SessionProvider;
  query: string;
  onSelect: (cmd: string) => void;
  onClose: () => void;
  activeIndex: number;
  discoveredCommands?: DiscoveredCommand[];
};

export default function CommandSuggestions({
  provider,
  query,
  onSelect,
  onClose: _onClose,
  activeIndex,
  discoveredCommands,
}: CommandSuggestionsProps) {
  const { t } = useTranslation('chat');
  const listRef = useRef<HTMLDivElement>(null);
  const { customCommands } = useCustomSlashCommands();

  const allCommands = buildCommandList(provider, customCommands, discoveredCommands ?? []);
  const filtered = allCommands.filter((c) =>
    c.cmd.toLowerCase().startsWith(`/${query.toLowerCase()}`),
  );

  // Show category headers only when showing all commands (empty query)
  const showCategories = query === '' && filtered.some((c) => c.category);

  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.querySelector(`[data-cmd-index="${activeIndex}"]`) as HTMLElement | null;
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (filtered.length === 0) return null;

  const renderCommandButton = (cmd: CommandEntry, index: number) => (
    <button
      key={cmd.cmd}
      type="button"
      data-cmd-index={index}
      onMouseDown={(e) => {
        e.preventDefault();
        if (cmd.isCustom && cmd.prompt) {
          onSelect(cmd.prompt);
        } else {
          onSelect(cmd.cmd);
        }
      }}
      className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer w-full text-left ${
        index === activeIndex ? 'bg-accent' : 'hover:bg-accent/50'
      }`}
    >
      {cmd.isCustom && <span className="flex-shrink-0">⭐</span>}
      {cmd.isDiscovered && cmd.scope === 'user' && <span className="flex-shrink-0">🗂</span>}
      {cmd.isDiscovered && cmd.scope === 'project' && <span className="flex-shrink-0">📁</span>}
      <span className="font-mono text-foreground">{cmd.cmd}</span>
      <span className="text-muted-foreground">
        {cmd.descriptionKey ? t(cmd.descriptionKey, cmd.description) : cmd.description}
      </span>
    </button>
  );

  const renderCommands = () => {
    if (!showCategories) {
      return filtered.map((cmd, index) => renderCommandButton(cmd, index));
    }

    // Group by category
    const groups: { category: string; items: { cmd: CommandEntry; globalIndex: number }[] }[] = [];
    let currentCategory = '';
    for (let i = 0; i < filtered.length; i++) {
      const cat = filtered[i].category || '';
      if (cat !== currentCategory) {
        currentCategory = cat;
        groups.push({ category: cat, items: [] });
      }
      groups[groups.length - 1].items.push({ cmd: filtered[i], globalIndex: i });
    }

    return groups.map((group) => (
      <div key={group.category}>
        {group.category && (
          <div className="px-3 pt-2 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            {group.category === 'custom'
              ? '⭐ Custom'
              : group.category === 'cli-user'
                ? '🗂 CLI Commands'
                : group.category === 'cli-project'
                  ? '📁 Project Commands'
                  : t(`commands.category.${group.category}`, group.category)}
          </div>
        )}
        {group.items.map(({ cmd, globalIndex }) => renderCommandButton(cmd, globalIndex))}
      </div>
    ));
  };

  return (
    <div
      ref={listRef}
      className="absolute bottom-full mb-2 left-0 right-0 max-h-56 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg py-1 z-30"
    >
      <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t('commands.title', 'Commands')}
      </div>
      {renderCommands()}
    </div>
  );
}
