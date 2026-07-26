import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * SettingsSection — shared card container for settings panels.
 *
 * Header layouts vary per panel (h3/h4 headings, lucide icons or emoji,
 * right-side action rows), so this component intentionally owns only the
 * outer card shell; titles and descriptions stay in the children.
 */
interface SettingsSectionProps {
  children: ReactNode;
  className?: string;
}

export function SettingsSection({ children, className }: SettingsSectionProps) {
  return (
    <section
      className={cn(
        'rounded-lg border border-border bg-card/80 backdrop-blur-md p-4 shadow-sm',
        className,
      )}
    >
      {children}
    </section>
  );
}
