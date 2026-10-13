import type { ChatPart } from '@threadterm/protocol';
import { approvalData } from './chatApproval';
import { toolView, type ToolView } from './toolView';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Unwrap native approval envelopes, then reuse the tool-card classifier. */
export function approvalPreview(part: ChatPart): Extract<ToolView, { kind: 'edit' | 'command' }> | undefined {
  const approval = approvalData(part);
  if (!approval) return undefined;
  const details = record(approval.details);
  const call = record(details.toolCall);
  const item = record(details.item);
  const metadata = record(details.metadata);
  const data = Object.keys(call).length ? call : Object.keys(item).length ? { ...details, ...item } : details;
  const toolName = typeof data.toolName === 'string' ? data.toolName : typeof data.tool === 'string' ? data.tool : typeof data.title === 'string' ? data.title : approval.title;
  const kind = data.kind ?? (Array.isArray(data.changes) ? 'edit' : typeof data.command === 'string' ? 'execute' : undefined);
  const shaped = metadata.diff !== undefined && data.state === undefined ? { ...data, kind: kind ?? 'edit', state: { input: metadata, metadata } } : { ...data, kind };
  const view = toolView({ type: 'tool', toolName, status: part.status, data: shaped });
  return view.kind === 'edit' || view.kind === 'command' ? view : undefined;
}
