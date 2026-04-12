import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { loop as loopApi } from '../../../lib/tauri-bridge';
import type { LoopConfig } from '../../../lib/tauri-bridge';

interface LoopDialogProps {
  projectPath: string;
  onClose: () => void;
}

const PROVIDERS = ['claude', 'codex', 'cursor'] as const;

export function LoopDialog({ projectPath, onClose }: LoopDialogProps) {
  const { t } = useTranslation('common');
  const [workerProvider, setWorkerProvider] = useState<string>('claude');
  const [verifierProvider, setVerifierProvider] = useState<string>('codex');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [verifyPrompt, setVerifyPrompt] = useState(
    'Review the following work and determine if it is complete and correct.',
  );
  const [maxIterations, setMaxIterations] = useState(3);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async () => {
    if (!taskPrompt.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const config: LoopConfig = {
        projectPath,
        workerProvider,
        verifierProvider,
        taskPrompt: taskPrompt.trim(),
        verifyPrompt: verifyPrompt.trim(),
        maxIterations,
      };
      await loopApi.start(config);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">{t('loop.title')}</h2>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium">{t('loop.workerProvider')}</span>
              <select
                className="mt-1 w-full h-8 px-2 text-sm rounded-md border border-input bg-background"
                value={workerProvider}
                onChange={(e) => setWorkerProvider(e.target.value)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium">{t('loop.verifierProvider')}</span>
              <select
                className="mt-1 w-full h-8 px-2 text-sm rounded-md border border-input bg-background"
                value={verifierProvider}
                onChange={(e) => setVerifierProvider(e.target.value)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium">{t('loop.taskPrompt')}</span>
            <textarea
              className="mt-1 w-full h-24 px-2 py-1.5 text-sm rounded-md border border-input bg-background resize-none"
              placeholder={t('loop.taskPromptPlaceholder')}
              value={taskPrompt}
              onChange={(e) => setTaskPrompt(e.target.value)}
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium">{t('loop.verifyPrompt')}</span>
            <textarea
              className="mt-1 w-full h-16 px-2 py-1.5 text-sm rounded-md border border-input bg-background resize-none"
              value={verifyPrompt}
              onChange={(e) => setVerifyPrompt(e.target.value)}
            />
          </label>

          <label className="flex items-center gap-3">
            <span className="text-xs font-medium">{t('loop.maxIterations')}</span>
            <input
              type="range"
              min={1}
              max={10}
              value={maxIterations}
              onChange={(e) => setMaxIterations(Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-sm font-mono w-6 text-center">{maxIterations}</span>
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('buttons.cancel')}
          </Button>
          <Button size="sm" disabled={starting || !taskPrompt.trim()} onClick={handleStart}>
            {starting ? t('status.loading') : t('loop.startLoop')}
          </Button>
        </div>
      </div>
    </div>
  );
}
