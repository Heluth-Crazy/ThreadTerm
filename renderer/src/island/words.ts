import type { ChatPart } from '@threadterm/protocol';
import { approvalData } from '../chatApproval';
import { approvalPreview } from '../approvalPreview';
import type { IslandItem } from './model';

/* Every word the task island shows, in both languages. Pure, so the wording is tested without a window. */

export const clockText = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
};

/** What a waiting session wants, read from its pending approval: a command, files to change, a question, or a title. */
export type IslandAsk = { kind: 'command' | 'edit' | 'question' | 'other'; text: string };
export function islandAsk(part: ChatPart | undefined, zh: boolean): IslandAsk | undefined {
  if (!part) return undefined;
  const data = approvalData(part);
  const raw = part.data && typeof part.data === 'object' && !Array.isArray(part.data) ? part.data as Record<string, unknown> : {};
  if (data?.interaction === 'userInput' || data?.interaction === 'elicitation' || raw.interaction === 'question') {
    const form = raw.form && typeof raw.form === 'object' ? raw.form as { questions?: { question?: unknown }[] } : undefined;
    const question = form?.questions?.find(row => typeof row.question === 'string' && row.question.trim())?.question;
    const text = typeof question === 'string' ? question : data?.title;
    return text?.trim() ? { kind: 'question', text: oneLine(text) } : undefined;
  }
  if (data?.interaction === 'plan') return { kind: 'other', text: zh ? '计划等你确认' : 'A plan to review' };
  try {
    const preview = approvalPreview(part);
    if (preview?.kind === 'command' && preview.command.trim()) return { kind: 'command', text: oneLine(preview.command) };
    if (preview?.kind === 'edit' && preview.files.length) {
      const names = preview.files.map(file => file.path.split(/[\\/]/).pop() || file.path);
      return { kind: 'edit', text: names.length > 2 ? (zh ? `${names.slice(0, 2).join('、')} 等 ${names.length} 个文件` : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`) : names.join(zh ? '、' : ', ') };
    }
  } catch { /* an approval shape the tool classifier does not know: fall back to its title */ }
  return data?.title?.trim() ? { kind: 'other', text: oneLine(data.title) } : undefined;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function islandWords(zh: boolean) {
  const t = (cn: string, en: string) => (zh ? cn : en);
  return {
    region: t('ThreadTerm 任务', 'ThreadTerm tasks'),
    running: t('正在运行', 'Running'),
    tasks: (count: number) => t(`${count} 个任务`, `${count} tasks`),
    runningLabel: (count: number) => t(`${count} 个任务正在运行`, `${count} tasks running`),
    waitingCompact: (item: IslandItem, ask?: IslandAsk) => (item.state === 'input' || ask?.kind === 'question' ? t('等你回复', 'Waiting for you') : t('等你批准', 'Needs approval')),
    waitingMany: (count: number) => t(`${count} 个等你处理`, `${count} need you`),
    waitingTitle: (item: IslandItem, ask?: IslandAsk) => (item.state === 'input' || ask?.kind === 'question'
      ? t(`${item.providerName} 在问你`, `${item.providerName} is asking`)
      : t(`${item.providerName} 等你批准`, `${item.providerName} needs approval`)),
    askLabel: (ask: IslandAsk) => (ask.kind === 'command' ? t('想运行', 'Wants to run') : ask.kind === 'edit' ? t('想修改', 'Wants to edit') : ''),
    later: t('稍后', 'Later'),
    go: (item: IslandItem, ask?: IslandAsk) => (item.state === 'input' || ask?.kind === 'question' ? t('去回复', 'Reply') : t('去批准', 'Review')),
    more: (count: number) => t(`还有 ${count} 个任务在等你`, `${count} more waiting`),
    done: t('已完成', 'Done'),
    failed: t('出错了', 'Failed'),
    finishedTitle: (item: IslandItem) => (item.state === 'done' ? t(`${item.providerName} 已完成`, `${item.providerName} finished`) : t(`${item.providerName} 出错了`, `${item.providerName} failed`)),
    took: (ms: number) => t(`用时 ${clockText(ms)}`, `took ${clockText(ms)}`),
    view: t('查看', 'View'),
    openApp: t('打开 ThreadTerm', 'Open ThreadTerm'),
    finishedFallback: (item: IslandItem) => (item.state === 'done' ? t('这一轮已经完成。', 'This turn is complete.') : t('这一轮没有完成。', 'This turn did not finish.')),
    /** Session · project (· computer): who and where, under a title or in a list row. */
    place: (item: IslandItem) => [item.title, item.project, item.machineName].filter(Boolean).join(' · '),
    meta: (item: IslandItem) => [item.providerName, item.project, item.machineName].filter(Boolean).join(' · '),
  };
}
export type IslandWords = ReturnType<typeof islandWords>;
