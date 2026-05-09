import * as React from 'react';
import { cn } from '@/lib/utils';

interface PopoverContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

export interface PopoverProps {
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({ children, open, defaultOpen = false, onOpenChange }: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const actualOpen = open ?? uncontrolledOpen;

  const setActualOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
  );

  React.useEffect(() => {
    if (!actualOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActualOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actualOpen, setActualOpen]);

  return (
    <PopoverContext.Provider value={{ open: actualOpen, setOpen: setActualOpen }}>
      <span className="relative inline-flex">{children}</span>
    </PopoverContext.Provider>
  );
}

export interface PopoverTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

export const PopoverTrigger = React.forwardRef<HTMLButtonElement, PopoverTriggerProps>(
  ({ asChild: _asChild, onClick, ...props }, ref) => {
    const context = React.useContext(PopoverContext);
    if (!context) {
      throw new Error('PopoverTrigger must be used inside Popover');
    }

    return (
      <button
        ref={ref}
        type="button"
        aria-expanded={context.open}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            context.setOpen(!context.open);
          }
        }}
        {...props}
      />
    );
  },
);
PopoverTrigger.displayName = 'PopoverTrigger';

export interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
}

export const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  ({ align = 'center', side = 'bottom', className, ...props }, ref) => {
    const context = React.useContext(PopoverContext);
    if (!context) {
      throw new Error('PopoverContent must be used inside Popover');
    }
    if (!context.open) return null;

    const sideClass =
      side === 'top'
        ? 'bottom-full mb-1'
        : side === 'bottom'
          ? 'top-full mt-1'
          : side === 'left'
            ? 'right-full mr-1'
            : 'left-full ml-1';
    const alignClass =
      align === 'start' ? 'left-0' : align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2';

    return (
      <div
        ref={ref}
        className={cn(
          'absolute z-50 rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none',
          sideClass,
          alignClass,
          className,
        )}
        {...props}
      />
    );
  },
);
PopoverContent.displayName = 'PopoverContent';
