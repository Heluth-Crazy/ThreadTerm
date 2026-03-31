import type { ReactNode } from 'react';
import MobileBottomTabs, { type MobilePrimaryTab } from './MobileBottomTabs';

type MobileWorkbenchShellProps = {
  activeTab: MobilePrimaryTab;
  onSelectTab: (tab: MobilePrimaryTab) => void;
  children: ReactNode;
};

export default function MobileWorkbenchShell({
  activeTab,
  onSelectTab,
  children,
}: MobileWorkbenchShellProps) {
  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <main className="min-h-0 flex-1 overflow-hidden pb-[calc(4.5rem+env(safe-area-inset-bottom))]">
        {children}
      </main>
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border/60 bg-card/95 px-3 pb-[max(env(safe-area-inset-bottom),0.625rem)] pt-2 backdrop-blur">
        <MobileBottomTabs activeTab={activeTab} onSelectTab={onSelectTab} />
      </div>
    </div>
  );
}

