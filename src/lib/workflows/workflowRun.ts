import type {
  TerminalAiIntent,
  TerminalType,
} from '../../types/terminal';
import type { Workflow } from './parseWorkflow';

const TERMINAL_TYPES: ReadonlySet<TerminalType> = new Set([
  'shell',
  'claude',
  'codex',
  'gemini',
  'npm',
  'yarn',
  'pnpm',
  'docker',
  'python',
  'node',
  'custom',
]);

const AI_INTENTS: ReadonlySet<TerminalAiIntent> = new Set([
  'review',
  'fix',
  'research',
  'test',
  'docs',
]);

export function workflowTerminalType(workflow: Workflow): TerminalType {
  const intent = workflow.intent;
  return intent && TERMINAL_TYPES.has(intent as TerminalType)
    ? (intent as TerminalType)
    : 'shell';
}

export function workflowAiIntent(workflow: Workflow): TerminalAiIntent | null {
  const intent = workflow.intent;
  return intent && AI_INTENTS.has(intent as TerminalAiIntent)
    ? (intent as TerminalAiIntent)
    : null;
}

export function missingDefaultArgs(workflow: Workflow): string[] {
  return workflow.arguments
    ?.filter((arg) => typeof arg.default_value !== 'string')
    .map((arg) => arg.name) ?? [];
}
