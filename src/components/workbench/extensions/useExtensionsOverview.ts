import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../utils/api';
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

async function readJson(response: Response) {
  const data = await response.json();
  return { response, data };
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

    const [skillsResult, claudeResult, codexResult] = await Promise.allSettled([
      api.skills.list().then(readJson),
      api.mcp.claudeConfig().then(readJson),
      api.mcp.codexList().then(readJson),
    ]);

    if (skillsResult.status === 'fulfilled') {
      const { response, data } = skillsResult.value;
      if (response.ok && data.success !== false) {
        const skillItems = Array.isArray(data.skills) ? data.skills : [];
        const roots = Array.isArray(data.roots) ? data.roots : [];
        setSkills({
          totalCount: skillItems.length,
          recentSkills: [...skillItems]
            .sort((left, right) => parseSkillsTimestamp(right) - parseSkillsTimestamp(left))
            .slice(0, 3),
          writableRootCount: roots.filter((root: { writable?: boolean }) => Boolean(root.writable)).length,
          error: null,
        });
      } else {
        setSkills({
          ...EMPTY_SKILLS,
          error: data.error || data.message || t('workbench.extensionsOverview.errors.skills'),
        });
      }
    } else {
      setSkills({
        ...EMPTY_SKILLS,
        error: skillsResult.reason instanceof Error ? skillsResult.reason.message : t('workbench.extensionsOverview.errors.skills'),
      });
    }

    const claudeServersResult =
      claudeResult.status === 'fulfilled' && claudeResult.value.response.ok && claudeResult.value.data.success !== false
        ? Array.isArray(claudeResult.value.data.servers)
          ? claudeResult.value.data.servers
          : []
        : null;
    const codexServersResult =
      codexResult.status === 'fulfilled' && codexResult.value.response.ok && codexResult.value.data.success !== false
        ? Array.isArray(codexResult.value.data.servers)
          ? codexResult.value.data.servers
          : []
        : null;

    const mcpErrorMessages = [
      claudeServersResult === null
        ? claudeResult.status === 'fulfilled'
          ? claudeResult.value.data.error || claudeResult.value.data.message || t('workbench.extensionsOverview.errors.mcp')
          : claudeResult.reason instanceof Error
            ? claudeResult.reason.message
            : t('workbench.extensionsOverview.errors.mcp')
        : null,
      codexServersResult === null
        ? codexResult.status === 'fulfilled'
          ? codexResult.value.data.error || codexResult.value.data.message || t('workbench.extensionsOverview.errors.mcp')
          : codexResult.reason instanceof Error
            ? codexResult.reason.message
            : t('workbench.extensionsOverview.errors.mcp')
        : null,
    ].filter(Boolean);

    setMcp({
      totalCount: (claudeServersResult?.length || 0) + (codexServersResult?.length || 0),
      claudeCount: claudeServersResult?.length || 0,
      codexCount: codexServersResult?.length || 0,
      error: mcpErrorMessages.length > 0 ? mcpErrorMessages.join(' / ') : null,
    });

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
