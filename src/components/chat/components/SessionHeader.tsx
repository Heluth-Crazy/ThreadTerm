import { Sparkles } from 'lucide-react';
import SessionProviderLogo from '../../SessionProviderLogo';
import type { SessionProvider } from '../../../types/app';
import type { ProviderThemeConfig } from '../types/chatTypes';
import { MODEL_OPTIONS } from '../utils/chatConstants';
import { getProviderDisplayName } from '../utils/chatUtils';
import { getProviderDotClass } from '../../../utils/providerColors';

type SessionHeaderProps = {
  activeProvider: SessionProvider;
  providerTheme: ProviderThemeConfig;
  model: string;
  canSwitchModelInSession: boolean;
  isSessionActive: boolean;
  onProviderChange: (provider: SessionProvider) => void;
  onModelChange: (model: string) => void;
};

export default function SessionHeader({
  activeProvider,
  providerTheme,
  model,
  canSwitchModelInSession,
  isSessionActive,
  onProviderChange,
  onModelChange,
}: SessionHeaderProps) {
  return (
    <div className={`flex flex-wrap items-center gap-2 px-3 py-2 border-b ${providerTheme.header}`}>
      <div className="flex min-w-0 items-center gap-2">
        <SessionProviderLogo provider={activeProvider} className="w-4 h-4 shrink-0" />
        <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${getProviderDotClass(activeProvider)}`} />
        <Sparkles className={`w-4 h-4 shrink-0 ${providerTheme.headerIcon}`} />
        <span className={`text-sm font-semibold tracking-tight truncate ${providerTheme.headerTitle}`}>
          {getProviderDisplayName(activeProvider)} Chat
        </span>
        <span className={`hidden md:inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${providerTheme.brandBadge}`}>
          {activeProvider === 'codex' ? 'OpenAI Style' : 'Claude Style'}
        </span>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        <select
          className="mobile-ime-input h-8 w-24 md:w-[116px] rounded-md border border-input bg-background px-2 text-xs"
          value={activeProvider}
          onChange={(event) => onProviderChange(event.target.value as SessionProvider)}
          disabled={isSessionActive}
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <select
          className="mobile-ime-input h-8 w-40 md:w-[190px] rounded-md border border-input bg-background px-2 text-xs"
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={!canSwitchModelInSession}
          title="Select model"
        >
          {(MODEL_OPTIONS[activeProvider] || []).map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
