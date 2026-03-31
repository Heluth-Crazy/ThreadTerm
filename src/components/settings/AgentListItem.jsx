import { cn } from '../../lib/utils';
import SessionProviderLogo from '../SessionProviderLogo';

const agentConfig = {
  claude: {
    name: 'Claude',
    tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  codex: {
    name: 'Codex',
    tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
};

export default function AgentListItem({ agentId, isSelected, onClick }) {
  const config = agentConfig[agentId];

  return (
    <button
      onClick={onClick}
      className={cn(
        'group relative w-full overflow-hidden rounded-xl border px-3 py-3 text-left transition-all',
        isSelected
          ? 'border-foreground/12 bg-background shadow-sm ring-1 ring-foreground/6'
          : 'border-transparent bg-transparent hover:border-border/70 hover:bg-background/80',
      )}
    >
      <div
        className={cn(
          'absolute inset-y-2 left-0 w-1 rounded-r-full bg-transparent transition-colors',
          isSelected ? 'bg-foreground/80' : 'group-hover:bg-border',
        )}
      />
      <div className="flex items-center gap-3 pl-1">
        <div className={cn('flex h-8 w-8 items-center justify-center rounded-xl', config.tone)}>
          <SessionProviderLogo provider={agentId} className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{config.name}</div>
          <div className="mt-0.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Agent</div>
        </div>
      </div>
    </button>
  );
}
