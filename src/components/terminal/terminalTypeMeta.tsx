/**
 * Per-terminal-type visual metadata: icon, accent colour, display label,
 * and default launch command. Centralised here so the card, switcher and
 * create dialog all stay in sync.
 */
import type { ComponentType } from 'react';
import {
  Container,
  FileCode,
  Package,
  Terminal as TerminalIcon,
} from 'lucide-react';
import type { TerminalType } from '../../types/terminal';
import {
  ClaudeBrandIcon,
  CodexBrandIcon,
  GeminiBrandIcon,
  GrokBrandIcon,
  KimiBrandIcon,
  OpencodeBrandIcon,
} from './agentIcons';

export interface TerminalTypeMeta {
  label: string;
  /** Lucide generic icon or inline brand-SVG component; rendered via <Icon className=... />. */
  Icon: ComponentType<{ className?: string }>;
  /** Tailwind colour accent (text-*). */
  accent: string;
  /** Default command to launch after PTY spawn. Empty string = no command. */
  defaultCommand: string;
}

export const terminalTypeMeta: Record<TerminalType, TerminalTypeMeta> = {
  shell: {
    label: 'Shell',
    Icon: TerminalIcon,
    accent: 'text-slate-500',
    defaultCommand: '',
  },
  claude: {
    label: 'Claude',
    Icon: ClaudeBrandIcon,
    accent: 'text-amber-500',
    defaultCommand: 'claude',
  },
  codex: {
    label: 'Codex',
    Icon: CodexBrandIcon,
    accent: 'text-emerald-500',
    defaultCommand: 'codex',
  },
  opencode: {
    label: 'OpenCode',
    Icon: OpencodeBrandIcon,
    accent: 'text-indigo-500',
    defaultCommand: 'opencode',
  },
  gemini: {
    label: 'Gemini',
    Icon: GeminiBrandIcon,
    accent: 'text-sky-500',
    defaultCommand: 'gemini',
  },
  kimi: {
    label: 'Kimi Code',
    Icon: KimiBrandIcon,
    accent: 'text-fuchsia-500',
    defaultCommand: 'kimi',
  },
  grok: {
    label: 'Grok Build',
    Icon: GrokBrandIcon,
    accent: 'text-orange-500',
    defaultCommand: 'grok',
  },
  npm: {
    label: 'npm',
    Icon: Package,
    accent: 'text-red-500',
    defaultCommand: '',
  },
  yarn: {
    label: 'Yarn',
    Icon: Package,
    accent: 'text-sky-600',
    defaultCommand: '',
  },
  pnpm: {
    label: 'pnpm',
    Icon: Package,
    accent: 'text-orange-500',
    defaultCommand: '',
  },
  docker: {
    label: 'Docker',
    Icon: Container,
    accent: 'text-blue-500',
    defaultCommand: '',
  },
  python: {
    label: 'Python',
    Icon: FileCode,
    accent: 'text-yellow-500',
    defaultCommand: 'python3',
  },
  node: {
    label: 'Node.js',
    Icon: FileCode,
    accent: 'text-green-500',
    defaultCommand: 'node',
  },
  custom: {
    label: 'Custom',
    Icon: TerminalIcon,
    accent: 'text-violet-500',
    defaultCommand: '',
  },
};

export function getTerminalTypeMeta(type: TerminalType): TerminalTypeMeta {
  return terminalTypeMeta[type] ?? terminalTypeMeta.custom;
}
