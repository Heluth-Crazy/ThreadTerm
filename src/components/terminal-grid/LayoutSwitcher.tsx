import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GridLayout } from './TerminalGrid';

interface LayoutSwitcherProps {
  layout: GridLayout;
  onChange: (layout: GridLayout) => void;
}

const layouts: { id: GridLayout; label: string; icon: React.ReactNode }[] = [
  {
    id: '1x1',
    label: '1×1',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <rect x="1" y="1" width="14" height="14" rx="1" />
      </svg>
    ),
  },
  {
    id: '1x2',
    label: '1×2',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <rect x="1" y="1" width="6" height="14" rx="1" />
        <rect x="9" y="1" width="6" height="14" rx="1" />
      </svg>
    ),
  },
  {
    id: '2x2',
    label: '2×2',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <rect x="1" y="1" width="6" height="6" rx="1" />
        <rect x="9" y="1" width="6" height="6" rx="1" />
        <rect x="1" y="9" width="6" height="6" rx="1" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
      </svg>
    ),
  },
];

export default function LayoutSwitcher({ layout, onChange }: LayoutSwitcherProps) {
  const { t } = useTranslation('terminal');
  return (
    <div className="flex items-center gap-1">
      {layouts.map((l) => {
        const isActive = l.id === layout;
        return (
          <button
            key={l.id}
            onClick={() => onChange(l.id)}
            title={t('layoutLabel', { label: l.label })}
            className={`p-1 rounded transition-colors ${
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
          >
            {l.icon}
          </button>
        );
      })}
    </div>
  );
}
