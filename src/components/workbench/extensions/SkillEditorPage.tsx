import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { Eye, FilePlus2, PencilLine, RotateCcw, Save, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import type { SkillRecord, SkillRoot } from './useSkills';
import { buildSkillTemplate } from './useSkills';

type SkillEditorPageProps = {
  roots: SkillRoot[];
  skill: SkillRecord | null;
  isLoading: boolean;
  isSaving: boolean;
  createNonce: number;
  onCreate: (payload: { rootId: string; slug: string; content: string }) => Promise<void>;
  onSave: (skillId: string, content: string) => Promise<void>;
  onDelete: (skillId: string) => Promise<void>;
};

export default function SkillEditorPage({
  roots,
  skill,
  isLoading,
  isSaving,
  createNonce,
  onCreate,
  onSave,
  onDelete,
}: SkillEditorPageProps) {
  const { t } = useTranslation('sidebar');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [draftRootId, setDraftRootId] = useState<string>('');
  const [draftSlug, setDraftSlug] = useState<string>('');
  const [editorContent, setEditorContent] = useState<string>('');
  const [isCreating, setIsCreating] = useState(false);

  const defaultRootId = roots.find((root) => root.writable)?.id || roots[0]?.id || '';

  useEffect(() => {
    if (skill) {
      setIsCreating(false);
      setEditorContent(skill.content || '');
    }
  }, [skill]);

  useEffect(() => {
    if (createNonce === 0) {
      return;
    }

    const slug = 'my-skill';
    setIsCreating(true);
    setMode('edit');
    setDraftRootId(defaultRootId);
    setDraftSlug(slug);
    setEditorContent(
      buildSkillTemplate(slug, {
        description: t('workbench.skillsPage.template.description'),
        overviewTitle: t('workbench.skillsPage.template.overviewTitle'),
        overviewBody: t('workbench.skillsPage.template.overviewBody'),
        workflowTitle: t('workbench.skillsPage.template.workflowTitle'),
        workflowSteps: [
          t('workbench.skillsPage.template.stepInspect'),
          t('workbench.skillsPage.template.stepApply'),
          t('workbench.skillsPage.template.stepVerify'),
        ],
      }),
    );
  }, [createNonce, defaultRootId, t]);

  const markdownPreview = useMemo(
    () => <ReactMarkdown remarkPlugins={[remarkGfm]}>{editorContent}</ReactMarkdown>,
    [editorContent],
  );

  const handleCancelCreate = () => {
    setIsCreating(false);
    setDraftRootId(defaultRootId);
    setDraftSlug('');
    setEditorContent(skill?.content || '');
  };

  const handleSave = async () => {
    if (isCreating) {
      await onCreate({
        rootId: draftRootId || defaultRootId,
        slug: draftSlug.trim() || 'my-skill',
        content: editorContent,
      });
      setIsCreating(false);
      return;
    }

    if (skill) {
      await onSave(skill.id, editorContent);
    }
  };

  const handleDelete = async () => {
    if (!skill) {
      return;
    }
    if (!window.confirm(t('workbench.skillsPage.editor.confirmDelete', { name: skill.name }))) {
      return;
    }
    await onDelete(skill.id);
  };

  const handleResetTemplate = () => {
    const nextSlug = isCreating ? draftSlug || 'my-skill' : skill?.slug || 'my-skill';
    setEditorContent(
      buildSkillTemplate(nextSlug, {
        description: t('workbench.skillsPage.template.description'),
        overviewTitle: t('workbench.skillsPage.template.overviewTitle'),
        overviewBody: t('workbench.skillsPage.template.overviewBody'),
        workflowTitle: t('workbench.skillsPage.template.workflowTitle'),
        workflowSteps: [
          t('workbench.skillsPage.template.stepInspect'),
          t('workbench.skillsPage.template.stepApply'),
          t('workbench.skillsPage.template.stepVerify'),
        ],
      }),
    );
  };

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('workbench.skillsPage.editor.loading')}</div>;
  }

  if (!skill && !isCreating) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-4">
        <div className="max-w-sm rounded-[22px] border border-border/60 bg-card/70 p-5 text-center shadow-sm">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <FilePlus2 className="h-4.5 w-4.5" />
          </div>
          <h2 className="mb-1 text-base font-semibold text-foreground">{t('workbench.skillsPage.editor.emptyTitle')}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t('workbench.skillsPage.editor.emptyDescription')}{' '}
            <span className="font-medium text-foreground">{t('workbench.skillsPage.newSkill')}</span>
            {t('workbench.skillsPage.editor.emptyDescriptionSuffix')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex flex-col gap-2.5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]">
                {isCreating
                  ? t('workbench.skillsPage.editor.createEyebrow')
                  : skill?.rootLabel || t('workbench.skillsPage.editor.skillEyebrow')}
              </Badge>
              {!isCreating && skill?.provider ? (
                <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase">
                  {skill.provider}
                </Badge>
              ) : null}
              <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase">
                SKILL.md
              </Badge>
            </div>
            <h2 className="mt-1.5 truncate text-base font-semibold text-foreground">
              {isCreating
                ? draftSlug || t('workbench.skillsPage.editor.newSkillName')
                : skill?.name || t('workbench.skillsPage.editor.skillEyebrow')}
            </h2>
            <p className="mt-1 truncate text-xs leading-5 text-muted-foreground">
              {isCreating ? t('workbench.skillsPage.editor.createDescription') : skill?.path}
            </p>
          </div>

          <div className="flex flex-col gap-2 xl:items-end">
            <div className="inline-flex rounded-lg border border-border/70 bg-card/70 p-0.5">
              <Button
                type="button"
                size="sm"
                variant={mode === 'edit' ? 'default' : 'ghost'}
                onClick={() => setMode('edit')}
                className={cn('h-8 rounded-md px-2.5 text-[13px]', mode === 'edit' ? 'shadow-sm' : '')}
              >
                <PencilLine className="h-3.5 w-3.5" />
                {t('workbench.skillsPage.editor.edit')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === 'preview' ? 'default' : 'ghost'}
                onClick={() => setMode('preview')}
                className={cn('h-8 rounded-md px-2.5 text-[13px]', mode === 'preview' ? 'shadow-sm' : '')}
              >
                <Eye className="h-3.5 w-3.5" />
                {t('workbench.skillsPage.editor.preview')}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button type="button" size="sm" variant="outline" onClick={handleResetTemplate} className="h-8 rounded-lg px-2.5 text-[13px]">
                <RotateCcw className="h-3.5 w-3.5" />
                {t('workbench.skillsPage.editor.template')}
              </Button>
              <Button type="button" size="sm" onClick={() => void handleSave()} disabled={isSaving} className="h-8 rounded-lg px-2.5 text-[13px]">
                <Save className="h-3.5 w-3.5" />
                {isSaving ? t('workbench.skillsPage.editor.saving') : t('workbench.skillsPage.editor.save')}
              </Button>
              {!isCreating ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleDelete()}
                  disabled={isSaving}
                  className="h-8 rounded-lg px-2.5 text-[13px]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('workbench.skillsPage.editor.delete')}
                </Button>
              ) : (
                <Button type="button" size="sm" variant="outline" onClick={handleCancelCreate} className="h-8 rounded-lg px-2.5 text-[13px]">
                  {t('actions.cancel')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {isCreating ? (
        <div className="grid gap-2 border-b border-border/60 bg-card/25 px-4 py-3 md:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span className="text-xs text-muted-foreground">{t('workbench.skillsPage.editor.targetRoot')}</span>
            <select
              value={draftRootId || defaultRootId}
              onChange={(event) => setDraftRootId(event.target.value)}
              className="flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-[13px]"
            >
              {roots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.label} ({root.path})
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="text-xs text-muted-foreground">{t('workbench.skillsPage.editor.folderSlug')}</span>
            <Input
              value={draftSlug}
              onChange={(event) => setDraftSlug(event.target.value)}
              placeholder={t('workbench.skillsPage.editor.folderSlugPlaceholder')}
              className="h-9 rounded-lg text-[13px]"
            />
          </label>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === 'preview' ? (
          <div className="h-full overflow-y-auto px-4 py-3 prose prose-sm max-w-none dark:prose-invert">
            {markdownPreview}
          </div>
        ) : (
          <CodeMirror
            value={editorContent}
            height="100%"
            extensions={[markdown()]}
            theme={oneDark}
            onChange={(value) => setEditorContent(value)}
            className="h-full text-sm"
          />
        )}
      </div>
    </div>
  );
}
