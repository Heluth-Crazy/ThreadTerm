import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { skills as skillsBridge } from '../../../lib/tauri-bridge';
import type { SkillRoot, SkillSummary, SkillRecord } from '../../../lib/tauri-bridge';

export type { SkillRoot, SkillSummary, SkillRecord };

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
      const data = await skillsBridge.list();
      setSkills(data.skills);
      setRoots(data.roots);
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
      const skill = await skillsBridge.read(skillId);
      setSelectedSkill(skill);
      return skill;
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
      const newSkill = await skillsBridge.create(payload.rootId, payload.slug, payload.content);
      await loadSkills();
      setSelectedSkill(newSkill);
      setSelectedSkillId(newSkill.id);
      return newSkill;
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
      const skill = await skillsBridge.update(skillId, content);
      await loadSkills();
      setSelectedSkill(skill);
      setSelectedSkillId(skillId);
      return skill;
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
      await skillsBridge.delete(skillId);
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
