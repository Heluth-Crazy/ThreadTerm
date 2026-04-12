import type { SessionTemplate } from '../../types/templates';

export const BUILT_IN_TEMPLATES: SessionTemplate[] = [
  {
    id: 'builtin-code-review',
    name: 'Code Review',
    description: 'Review this code for bugs, performance issues, and best practices.',
    icon: '🔍',
    provider: 'claude',
    initialMessage: 'Please review the code in [filename] and provide detailed feedback.',
    isBuiltIn: true,
  },
  {
    id: 'builtin-bug-fix',
    name: 'Bug Fix',
    description: 'Diagnose and fix the bug described below.',
    icon: '🐛',
    provider: 'claude',
    initialMessage: "I have a bug: [describe the bug]. Here's the relevant code: [paste code]",
    isBuiltIn: true,
  },
  {
    id: 'builtin-feature',
    name: 'Feature Implementation',
    description: 'Implement the following feature based on the requirements.',
    icon: '✨',
    provider: 'codex',
    initialMessage: 'Implement a feature that [describe feature]. Follow existing code patterns.',
    isBuiltIn: true,
  },
  {
    id: 'builtin-documentation',
    name: 'Documentation',
    description: 'Write comprehensive documentation for this code.',
    icon: '📝',
    provider: 'claude',
    initialMessage: 'Write documentation for [component/function/module].',
    isBuiltIn: true,
  },
  {
    id: 'builtin-refactoring',
    name: 'Refactoring',
    description: 'Refactor this code to improve readability and maintainability.',
    icon: '♻️',
    provider: 'claude',
    initialMessage: 'Refactor the following code to be cleaner and more maintainable: [paste code]',
    isBuiltIn: true,
  },
];
