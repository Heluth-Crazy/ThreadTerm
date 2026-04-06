import React, { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import HybridTerminalPane from './HybridTerminalPane';
import LayoutSwitcher from './LayoutSwitcher';
import type { GridLayout } from './TerminalGrid';
import type { Project } from '../../types/app';
import { getVisibleCount, getGridClass } from './utils/gridLayout';

export interface HybridTerminalGridProps {
  projects: Project[];
}

const PANE_IDS = ['1', '2', '3', '4'];

function HybridTerminalGrid({ projects }: HybridTerminalGridProps) {
  const { t } = useTranslation('terminal');
  const [layout, setLayout] = useState<GridLayout>('2x2');
  const [activePane, setActivePane] = useState<string>('1');
  const containerRef = useRef<HTMLDivElement>(null);

  const handleActivate = useCallback((id: string) => {
    setActivePane(id);
  }, []);

  const handleLayoutChange = useCallback((newLayout: GridLayout) => {
    setLayout(newLayout);
    const visibleCount = getVisibleCount(newLayout);
    if (parseInt(activePane, 10) > visibleCount) {
      setActivePane('1');
    }
  }, [activePane]);

  const visibleCount = getVisibleCount(layout);
  const gridClass = getGridClass(layout);

  return (
    <div ref={containerRef} className="h-full w-full flex flex-col">
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 font-medium">{t('hybridTerminalWindows', { count: visibleCount })}</span>
        </div>
        <LayoutSwitcher layout={layout} onChange={handleLayoutChange} />
      </div>

      <div className={`flex-1 min-h-0 grid gap-1 p-1 bg-gray-900 ${gridClass}`}>
        {PANE_IDS.slice(0, visibleCount).map((id) => (
          <HybridTerminalPane
            key={id}
            id={id}
            projects={projects}
            isActive={id === activePane}
            onActivate={handleActivate}
          />
        ))}
      </div>
    </div>
  );
}

export default React.memo(HybridTerminalGrid);
