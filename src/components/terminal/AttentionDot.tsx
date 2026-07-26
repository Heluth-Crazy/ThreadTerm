import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

/**
 * AttentionDot — shared "unread / needs attention" indicator dot.
 *
 * Decorative only: always rendered with `aria-hidden`. Callers position it
 * via `className` (e.g. `absolute right-3 top-3`).
 */
const attentionDotVariants = cva(
  'inline-block shrink-0 rounded-full bg-warning shadow-[0_0_0_3px_hsl(var(--warning)_/_0.15)]',
  {
    variants: {
      size: {
        sm: 'h-1.5 w-1.5',
        md: 'h-2 w-2',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  },
);

export interface AttentionDotProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof attentionDotVariants> {}

function AttentionDot({ className, size, ...props }: AttentionDotProps) {
  return (
    <span
      data-ui="attention-dot"
      aria-hidden="true"
      className={cn(attentionDotVariants({ size, className }))}
      {...props}
    />
  );
}

export { AttentionDot, attentionDotVariants };
