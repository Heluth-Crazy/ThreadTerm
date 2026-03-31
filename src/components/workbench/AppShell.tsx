import type { ReactNode } from 'react';

type AppShellProps = {
  activityBar: ReactNode;
  secondarySidebar: ReactNode;
  mainContent: ReactNode;
  hideSecondarySidebar?: boolean;
};

export default function AppShell({
  activityBar,
  secondarySidebar,
  mainContent,
  hideSecondarySidebar = false,
}: AppShellProps) {
  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="h-full flex-shrink-0">{activityBar}</div>
      {!hideSecondarySidebar && (
        <div className="h-full w-80 flex-shrink-0 border-r border-border/50">{secondarySidebar}</div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">{mainContent}</div>
    </div>
  );
}
