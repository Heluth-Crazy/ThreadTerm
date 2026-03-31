import { useCallback, useMemo, useState } from 'react';
import type { SessionProvider } from '../../../types/app';
import type { ProjectOverviewSessionRecord } from './projectOverviewModels';

export function useProjectOverviewState() {
  const [manageProvider, setManageProvider] = useState<SessionProvider | null>(null);
  const [selectedClaudeIds, setSelectedClaudeIds] = useState<string[]>([]);
  const [selectedCodexIds, setSelectedCodexIds] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);

  const selectedIdsByProvider = useMemo(
    () => ({
      claude: selectedClaudeIds,
      codex: selectedCodexIds,
    }),
    [selectedClaudeIds, selectedCodexIds],
  );

  const enterManageMode = useCallback((provider: SessionProvider) => {
    setManageProvider(provider);
  }, []);

  const exitManageMode = useCallback(() => {
    setManageProvider(null);
    setSelectedClaudeIds([]);
    setSelectedCodexIds([]);
  }, []);

  const toggleSelection = useCallback((provider: SessionProvider, sessionId: string) => {
    const setter = provider === 'claude' ? setSelectedClaudeIds : setSelectedCodexIds;

    setter((current) =>
      current.includes(sessionId)
        ? current.filter((item) => item !== sessionId)
        : [...current, sessionId],
    );
  }, []);

  const clearSelection = useCallback((provider: SessionProvider) => {
    if (provider === 'claude') {
      setSelectedClaudeIds([]);
      return;
    }

    setSelectedCodexIds([]);
  }, []);

  const selectAll = useCallback((provider: SessionProvider, records: ProjectOverviewSessionRecord[]) => {
    const ids = records.map((item) => item.session.id);

    if (provider === 'claude') {
      setSelectedClaudeIds(ids);
      return;
    }

    setSelectedCodexIds(ids);
  }, []);

  return {
    manageProvider,
    selectedIdsByProvider,
    isDeleting,
    setIsDeleting,
    enterManageMode,
    exitManageMode,
    toggleSelection,
    clearSelection,
    selectAll,
  };
}
