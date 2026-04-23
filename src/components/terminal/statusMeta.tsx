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
    tone: 'text-slate-400',
    chip: 'bg-slate-500/10 text-slate-400',
    animate: false,
  },
  running: {
    label: 'Running',
    Icon: Loader2,
    tone: 'text-emerald-500',
    chip: 'bg-emerald-500/10 text-emerald-500',
    animate: true,
  },
  waiting: {
    label: 'Waiting',
    Icon: Clock,
    tone: 'text-amber-500',
    chip: 'bg-amber-500/10 text-amber-600',
    animate: false,
  },
  completed: {
    label: 'Completed',
    Icon: CheckCircle2,
    tone: 'text-sky-500',
    chip: 'bg-sky-500/10 text-sky-600',
    animate: false,
  },
  failed: {
    label: 'Failed',
    Icon: XCircle,
    tone: 'text-red-500',
    chip: 'bg-red-500/10 text-red-500',
    animate: false,
  },
};

export function getStatusMeta(s: TerminalStatus): TerminalStatusMeta {
  return statusMeta[s] ?? statusMeta.idle;
}
