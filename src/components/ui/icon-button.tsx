import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const iconButtonVariants = cva(
  'inline-flex items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      size: {
        sm: 'h-7 w-7',
        md: 'h-8 w-8',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  },
);

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, size, type = 'button', title, 'aria-label': ariaLabel, ...props }, ref) => (
    <button
      data-ui="icon-button"
      type={type}
      title={title}
      aria-label={ariaLabel ?? title}
      className={cn(iconButtonVariants({ size, className }))}
      ref={ref}
      {...props}
    />
  ),
);
IconButton.displayName = 'IconButton';

export { IconButton, iconButtonVariants };
