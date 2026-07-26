/**
 * Visual metadata for {@link TerminalStatus}: icon, colour, pulse behaviour.
 */
import {
  CheckCircle2,
  Circle,
  Clock,
  Loader2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { TerminalStatus } from '../../types/terminal';

export interface TerminalStatusMeta {
  label: string;
  Icon: LucideIcon;
  /** Tailwind text colour token. */
  tone: string;
  /** Tailwind background tint used for status chips. */
  chip: string;
  /** Whether to pulse/animate the status icon. */
  animate: boolean;
}

export const statusMeta: Record<TerminalStatus, TerminalStatusMeta> = {
  idle: {
    label: 'Idle',
    Icon: Circle,
    tone: 'text-muted-foreground',
    chip: 'bg-muted text-muted-foreground',
    animate: false,
  },
  running: {
    label: 'Running',
    Icon: Loader2,
    tone: 'text-success',
    chip: 'bg-success/10 text-success',
    animate: true,
  },
  waiting: {
    label: 'Waiting',
    Icon: Clock,
    tone: 'text-warning',
    chip: 'bg-warning/10 text-warning',
    animate: false,
  },
  completed: {
    label: 'Completed',
    Icon: CheckCircle2,
    tone: 'text-info',
    chip: 'bg-info/10 text-info',
    animate: false,
  },
  failed: {
    label: 'Failed',
    Icon: XCircle,
    tone: 'text-destructive',
    chip: 'bg-destructive/10 text-destructive',
    animate: false,
  },
};

export function getStatusMeta(s: TerminalStatus): TerminalStatusMeta {
  return statusMeta[s] ?? statusMeta.idle;
}
