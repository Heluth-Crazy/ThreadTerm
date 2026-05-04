import type { AiExplainProvider } from './aiExplain';
import type { TerminalAiIntent } from '../../types/terminal';

export type AiSessionExportProvider = AiExplainProvider | 'unknown';
export type AiSessionExportMessageRole = 'user' | 'assistant';
export type AiSessionExportLaunchAction = 'start' | 'resume' | 'discover';

export interface AiSessionExportMessage {
  id: string;
  role: AiSessionExportMessageRole;
  content: string;
  provider?: AiSessionExportProvider;
  createdAt?: number | string | Date;
  state?: 'pending' | 'ok' | 'error';
}

export interface AiSessionExportSourceContext {
  kind: 'block' | 'card';
  cardId?: string;
  blockId?: string;
  projectName?: string;
  projectPath?: string;
  cwd?: string;
  command?: string;
  launchCommand?: string;
  launchAction?: AiSessionExportLaunchAction;
}

export interface AiSessionExportSource {
  title?: string;
  userIntent?: TerminalAiIntent | string | null;
  provider?: AiSessionExportProvider | null;
  sessionId?: string | null;
  startedAt?: number | string | Date | null;
  endedAt?: number | string | Date | null;
  sourceContext: AiSessionExportSourceContext;
  messages: AiSessionExportMessage[];
}

export function getAiSessionExportFilename(
  source: Pick<AiSessionExportSource, 'provider' | 'sourceContext'>,
  date = new Date(),
): string {
  const provider = source.provider ?? 'ai';
  const contextId = source.sourceContext.blockId ?? source.sourceContext.cardId ?? 'session';
  const slug = sanitizeFilenamePart(`${provider}-${contextId}`) || 'ai-session';
  return `threadterm-ai-${slug}-${date.toISOString().slice(0, 10)}.md`;
}

export function renderAiSessionMarkdown(source: AiSessionExportSource): string {
  const messages = source.messages
    .filter((message) => message.content.trim().length > 0 || message.state === 'pending')
    .sort((a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt));
  const startedAt = source.startedAt ?? messages[0]?.createdAt ?? null;
  const endedAt = source.endedAt ?? messages[messages.length - 1]?.createdAt ?? null;
  const title = source.title?.trim() || defaultTitle(source);
  const lines: string[] = [
    `# ${title}`,
    '',
    '## Metadata',
    '',
    `- User intent: ${inlineValue(source.userIntent ?? 'Not set')}`,
    `- Provider: ${inlineValue(source.provider ?? 'unknown')}`,
    `- Session id: ${inlineValue(source.sessionId ?? 'Not available')}`,
    `- Start time: ${inlineValue(formatDateTime(startedAt))}`,
    `- End time: ${inlineValue(formatDateTime(endedAt))}`,
    `- Source: ${formatSourceContext(source.sourceContext)}`,
    '',
    '## Conversation',
    '',
  ];

  if (messages.length === 0) {
    lines.push('_No prompt or reply content is available for this session._', '');
    return `${lines.join('\n')}\n`;
  }

  messages.forEach((message, index) => {
    const label = message.role === 'user' ? 'Prompt' : 'Reply';
    const detail = [
      message.provider ? `provider: ${message.provider}` : null,
      message.state && message.state !== 'ok' ? `state: ${message.state}` : null,
      formatDateTime(message.createdAt),
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`### ${index + 1}. ${label}`);
    if (detail) {
      lines.push('', `_${detail}_`);
    }
    lines.push('', renderMessageContent(message.content, message.state), '');
  });

  return `${lines.join('\n')}\n`;
}

function defaultTitle(source: AiSessionExportSource): string {
  if (source.sourceContext.kind === 'block') {
    return 'ThreadTerm AI Block Session';
  }
  return 'ThreadTerm AI Card Session';
}

function sanitizeFilenamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function timestampMs(value: AiSessionExportMessage['createdAt']): number {
  const ms = dateFrom(value)?.getTime();
  return Number.isFinite(ms) ? ms ?? 0 : 0;
}

function dateFrom(value: number | string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value: number | string | Date | null | undefined): string {
  return dateFrom(value)?.toISOString() ?? 'Not available';
}

function inlineValue(value: string | number): string {
  const text = String(value).trim();
  return text.length > 0 ? text : 'Not available';
}

function formatSourceContext(context: AiSessionExportSourceContext): string {
  const parts = [
    context.kind,
    context.projectName ? `project ${context.projectName}` : null,
    context.projectPath ? `path ${context.projectPath}` : null,
    context.cwd ? `cwd ${context.cwd}` : null,
    context.command ? `command ${context.command}` : null,
    context.launchAction ? `launch ${context.launchAction}` : null,
    context.launchCommand ? `launch command ${context.launchCommand}` : null,
    context.cardId ? `card ${context.cardId}` : null,
    context.blockId ? `block ${context.blockId}` : null,
  ].filter(Boolean);
  return parts.join('; ');
}

function renderMessageContent(content: string, state: AiSessionExportMessage['state']): string {
  if (state === 'pending') return '_Pending response._';
  const trimmed = content.trim();
  if (!trimmed) return '_No content._';
  return ensureSafeFences(trimmed);
}

function ensureSafeFences(markdown: string): string {
  const maxFenceLength = markdown
    .match(/`{3,}/g)
    ?.reduce((max, fence) => Math.max(max, fence.length), 2) ?? 2;
  const fence = '`'.repeat(maxFenceLength + 1);
  if (!markdown.includes('```')) return markdown;
  return `${fence}markdown\n${markdown}\n${fence}`;
}
