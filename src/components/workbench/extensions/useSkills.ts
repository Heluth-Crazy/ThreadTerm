import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../utils/api';

export type SkillRoot = {
  id: string;
  label: string;
  provider: string;
  path: string;
  exists: boolean;
  writable: boolean;
};

export type SkillSummary = {
  id: string;
  name: string;
  slug: string;
  description: string;
  provider: string;
  rootId: string;
  rootLabel: string;
  rootPath: string;
  path: string;
  filePath: string;
  updatedAt: string;
  writable: boolean;
};

export type SkillRecord = SkillSummary & {
  content: string;
  frontmatter?: Record<string, unknown>;
};

type CreatePayload = {
  rootId: string;
  slug: string;
  content: string;
};

type SkillTemplateCopy = {
  description: string;
  overviewTitle: string;
  overviewBody: string;
  workflowTitle: string;
  workflowSteps: [string, string, string];
};

async function readJson(response: Response, fallbackMessage: string) {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.message || fallbackMessage);
  }
  return data;
}

export function buildSkillTemplate(
  slug = 'my-skill',
  copy: Partial<SkillTemplateCopy> = {},
) {
  const safeSlug = String(slug || 'my-skill').trim() || 'my-skill';
  const templateCopy: SkillTemplateCopy = {
    description: copy.description || 'Short description of what this skill helps with',
    overviewTitle: copy.overviewTitle || 'Overview',
    overviewBody: copy.overviewBody || 'Describe what this skill does and when to use it.',
    workflowTitle: copy.workflowTitle || 'Workflow',
    workflowSteps: copy.workflowSteps || [
      'Inspect the relevant context',
      'Apply the skill-specific workflow',
      'Verify the final output',
    ],
  };

  return `---
name: ${safeSlug}
description: "${templateCopy.description}"
---

# ${safeSlug}

## ${templateCopy.overviewTitle}

${templateCopy.overviewBody}

## ${templateCopy.workflowTitle}

1. ${templateCopy.workflowSteps[0]}
2. ${templateCopy.workflowSteps[1]}
3. ${templateCopy.workflowSteps[2]}
`;
}

export function useSkills() {
  const { t } = useTranslation('sidebar');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [roots, setRoots] = useState<SkillRoot[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillRecord | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isLoadingSkill, setIsLoadingSkill] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    setIsLoadingList(true);
    setError(null);
    try {
      const data = await readJson(await api.skills.list(), t('workbench.skillsPage.errors.loadList'));
      setSkills(data.skills || []);
      setRoots(data.roots || []);
      return data;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('workbench.skillsPage.errors.loadList'));
      throw loadError;
    } finally {
      setIsLoadingList(false);
    }
  }, [t]);

  const selectSkill = useCallback(async (skillId: string) => {
    setIsLoadingSkill(true);
    setError(null);
    setSelectedSkillId(skillId);
    try {
      const data = await readJson(await api.skills.get(skillId), t('workbench.skillsPage.errors.loadSkill'));
      setSelectedSkill(data.skill || null);
      return data.skill as SkillRecord;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('workbench.skillsPage.errors.loadSkill'));
      throw loadError;
    } finally {
      setIsLoadingSkill(false);
    }
  }, [t]);

  const createSkill = useCallback(async (payload: CreatePayload) => {
    setIsSaving(true);
    setError(null);
    try {
      const data = await readJson(await api.skills.create(payload), t('workbench.skillsPage.errors.create'));
      await loadSkills();
      setSelectedSkill(data.skill || null);
      setSelectedSkillId(data.skill?.id || null);
      return data.skill as SkillRecord;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('workbench.skillsPage.errors.create'));
      throw saveError;
    } finally {
      setIsSaving(false);
    }
  }, [loadSkills, t]);

  const updateSkill = useCallback(async (skillId: string, content: string) => {
    setIsSaving(true);
    setError(null);
    try {
      const data = await readJson(await api.skills.update(skillId, { content }), t('workbench.skillsPage.errors.save'));
      await loadSkills();
      setSelectedSkill(data.skill || null);
      setSelectedSkillId(data.skill?.id || skillId);
      return data.skill as SkillRecord;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('workbench.skillsPage.errors.save'));
      throw saveError;
    } finally {
      setIsSaving(false);
    }
  }, [loadSkills, t]);

  const deleteSkill = useCallback(async (skillId: string) => {
    setIsSaving(true);
    setError(null);
    try {
      await readJson(await api.skills.delete(skillId), t('workbench.skillsPage.errors.delete'));
      await loadSkills();
      if (selectedSkillId === skillId) {
        setSelectedSkill(null);
        setSelectedSkillId(null);
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('workbench.skillsPage.errors.delete'));
      throw deleteError;
    } finally {
      setIsSaving(false);
    }
  }, [loadSkills, selectedSkillId, t]);

  const groupedSkills = useMemo(() => {
    return roots.map((root) => ({
      root,
      items: skills.filter((skill) => skill.rootId === root.id),
    }));
  }, [roots, skills]);

  return {
    roots,
    skills,
    groupedSkills,
    selectedSkill,
    selectedSkillId,
    isLoadingList,
    isLoadingSkill,
    isSaving,
    error,
    setError,
    setSelectedSkill,
    setSelectedSkillId,
    loadSkills,
    selectSkill,
    createSkill,
    updateSkill,
    deleteSkill,
  };
}
