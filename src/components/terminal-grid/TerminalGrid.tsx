import React, { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import TerminalPane from './TerminalPane';
import LayoutSwitcher from './LayoutSwitcher';
import { getVisibleCount, getGridClass } from './utils/gridLayout';

export type GridLayout = '1x1' | '1x2' | '2x2';

export interface TerminalGridProps {
  project: any;
  session?: any;
  onNewSession?: (project: any) => void;
}

const PANE_IDS = ['1', '2', '3', '4'];

function TerminalGrid({ project, session }: TerminalGridProps) {
  const { t } = useTranslation('terminal');
  const [layout, setLayout] = useState<GridLayout>('1x1');
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const num = parseInt(e.key, 10);
    if (num >= 1 && num <= getVisibleCount(layout)) {
      e.preventDefault();
      setActivePane(String(num));
    }
  }, [layout]);

  const visibleCount = getVisibleCount(layout);
  const gridClass = getGridClass(layout);

  return (
    <div ref={containerRef} className="h-full w-full flex flex-col" onKeyDown={handleKeyDown}>
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 font-medium">{t('terminalCount', { count: visibleCount })}</span>
          {layout !== '1x1' && <span className="text-xs text-gray-500">{t('switchShortcut', { count: visibleCount })}</span>}
        </div>
        <LayoutSwitcher layout={layout} onChange={handleLayoutChange} />
      </div>

      <div className={`flex-1 min-h-0 grid gap-1 p-1 bg-gray-900 ${gridClass}`}>
        {PANE_IDS.slice(0, visibleCount).map((id) => (
          <TerminalPane
            key={id === '1' && session ? `1-${session.id}` : id}
            id={id}
            project={project}
            session={id === '1' ? session : null}
            isActive={id === activePane}
            onActivate={handleActivate}
            label={id === '1' && session ? (session.summary || session.name || t('session')) : t('terminalId', { id })}
          />
        ))}
      </div>
    </div>
  );
}

export default React.memo(TerminalGrid);
