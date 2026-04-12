import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { useLoopStore } from '../../../stores/loopStore';
import { loop as loopApi } from '../../../lib/tauri-bridge';
import type { LoopState } from '../../../lib/tauri-bridge';

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  waiting_verification: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  passed: 'bg-green-500/20 text-green-400 border-green-500/30',
  failed: 'bg-red-500/20 text-red-400 border-red-500/30',
  cancelled: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

export function LoopStatusPanel() {
  const { t } = useTranslation('common');
  const loops = useLoopStore((s) => s.loops);
  const loopList = Object.values(loops);

  if (loopList.length === 0) return null;

  const handleCancel = async (loopId: string) => {
    try {
      await loopApi.cancel(loopId);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <h3 className="text-sm font-semibold">{t('loop.statusTitle')}</h3>
      {loopList.map((loop: LoopState) => {
        const colorClass = STATUS_COLORS[loop.status] ?? STATUS_COLORS.cancelled;
        const isActive = loop.status === 'running' || loop.status === 'waiting_verification';
        return (
          <div
            key={loop.loopId}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/50 bg-card"
          >
            <Badge className={`text-[10px] px-1.5 py-0 shrink-0 ${colorClass}`}>
              {t(`loop.status.${loop.status}`, loop.status)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {loop.config.workerProvider} → {loop.config.verifierProvider}
            </span>
            <span className="text-xs font-mono ml-auto">
              {loop.iteration}/{loop.config.maxIterations}
            </span>
            {isActive && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] text-destructive"
                onClick={() => handleCancel(loop.loopId)}
              >
                {t('buttons.cancel')}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
