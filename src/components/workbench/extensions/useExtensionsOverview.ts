import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { settings } from '../../../lib/tauri-bridge';
import type { SkillSummary } from './useSkills';

type SkillsCardState = {
  totalCount: number;
  recentSkills: SkillSummary[];
  writableRootCount: number;
  error: string | null;
};

type McpCardState = {
  totalCount: number;
  claudeCount: number;
  codexCount: number;
  error: string | null;
};

type OverviewHintTone = 'neutral' | 'warning';

type OverviewHint = {
  id: string;
  tone: OverviewHintTone;
  message: string;
};

const EMPTY_SKILLS: SkillsCardState = {
  totalCount: 0,
  recentSkills: [],
  writableRootCount: 0,
  error: null,
};

const EMPTY_MCP: McpCardState = {
  totalCount: 0,
  claudeCount: 0,
  codexCount: 0,
  error: null,
};

async function readJson(data: Record<string, unknown>) {
  return { response: { ok: true }, data };
}

function parseSkillsTimestamp(skill: SkillSummary): number {
  const timestamp = new Date(skill.updatedAt || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function useExtensionsOverview() {
  const { t } = useTranslation('sidebar');
  const [isLoading, setIsLoading] = useState(true);
  const [skills, setSkills] = useState<SkillsCardState>(EMPTY_SKILLS);
  const [mcp, setMcp] = useState<McpCardState>(EMPTY_MCP);

  const load = useCallback(async () => {
    setIsLoading(true);

    try {
      const allSettings = await settings.getAll();
      const skillItems = Array.isArray(allSettings?.skills) ? allSettings.skills as SkillSummary[] : [];
      const roots = Array.isArray(allSettings?.skillRoots) ? allSettings.skillRoots as Array<{ writable?: boolean }> : [];

      setSkills({
        totalCount: skillItems.length,
        recentSkills: [...skillItems]
          .sort((left, right) => parseSkillsTimestamp(right) - parseSkillsTimestamp(left))
          .slice(0, 3),
        writableRootCount: roots.filter((root) => Boolean(root.writable)).length,
        error: null,
      });

      // MCP config is stored in Claude/Codex config files, not easily accessible in Tauri mode
      setMcp({
        totalCount: 0,
        claudeCount: 0,
        codexCount: 0,
        error: null,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : t('workbench.extensionsOverview.errors.skills');
      setSkills({ ...EMPTY_SKILLS, error: errMsg });
      setMcp({ ...EMPTY_MCP, error: errMsg });
    }

    setIsLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const hints = useMemo<OverviewHint[]>(() => {
    const nextHints: OverviewHint[] = [];

    if (skills.error || mcp.error) {
      nextHints.push({
        id: 'partial',
        tone: 'warning',
        message: t('workbench.extensionsOverview.hints.partial'),
      });
    }

    if (!skills.error && skills.writableRootCount === 0) {
      nextHints.push({
        id: 'skills-readonly',
        tone: 'warning',
        message: t('workbench.extensionsOverview.hints.skillsReadOnly'),
      });
    }

    if (skills.totalCount === 0 && mcp.totalCount === 0) {
      nextHints.push({
        id: 'empty',
        tone: 'neutral',
        message: t('workbench.extensionsOverview.hints.empty'),
      });
    } else if (mcp.totalCount === 0) {
      nextHints.push({
        id: 'mcp-missing',
        tone: 'neutral',
        message: t('workbench.extensionsOverview.hints.mcpMissing'),
      });
    } else if (skills.totalCount === 0) {
      nextHints.push({
        id: 'skills-empty',
        tone: 'neutral',
        message: t('workbench.extensionsOverview.hints.skillsEmpty'),
      });
    }

    if (nextHints.length === 0) {
      nextHints.push({
        id: 'ready',
        tone: 'neutral',
        message: t('workbench.extensionsOverview.hints.ready'),
      });
    }

    return nextHints.slice(0, 3);
  }, [mcp.error, mcp.totalCount, skills.error, skills.totalCount, skills.writableRootCount, t]);

  return {
    isLoading,
    skills,
    mcp,
    hints,
    reload: load,
  };
}
