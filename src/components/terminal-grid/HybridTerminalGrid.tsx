import React, { useState, useCallback, useRef } from 'react';
import HybridTerminalPane from './HybridTerminalPane';
import LayoutSwitcher from './LayoutSwitcher';
import type { GridLayout } from './TerminalGrid';
import type { Project } from '../../types/app';

export interface HybridTerminalGridProps {
  projects: Project[];
}

function getVisibleCount(layout: GridLayout): number {
  switch (layout) {
    case '1x1': return 1;
    case '1x2': return 2;
    case '2x2': return 4;
  }
}

function getGridClass(layout: GridLayout): string {
  switch (layout) {
    case '1x1': return 'grid-cols-1 grid-rows-1';
    case '1x2': return 'grid-cols-2 grid-rows-1';
    case '2x2': return 'grid-cols-2 grid-rows-2';
  }
}

const PANE_IDS = ['1', '2', '3', '4'];

function HybridTerminalGrid({ projects }: HybridTerminalGridProps) {
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
          <span className="text-xs text-gray-400 font-medium">混合终端 · {visibleCount} 窗口</span>
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
