import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { contextDisplayMetadata, contextSerializedBlocks, parseContext, serializeContext, type ContextItem } from '../chatContext';
import { SurfaceDialog } from './SurfaceDialog';
import { Icon } from './PrototypeIcon';
import './context-tray.css';

type Chip = { id: string; kind: ContextItem['kind']; label: string; title: string; block: string };
const icons = { terminal: 'terminal', file: 'file', diff: 'branch', commit: 'clock', conversation: 'clock', quote: 'file', session: 'layers', agent: 'export', skill: 'spark' };
function localized(chip: Chip, zh: boolean) {
  if (chip.kind === 'file') return chip.label.replace(/:(\d+)-(\d+)$/, ':$1–$2');
  if (!zh) return chip.label;
  if (chip.kind === 'terminal') return chip.label.replace(/(\d+) lines?$/, '$1 行');
  if (chip.kind === 'diff') return chip.label.replace(/^Diff/, '差异');
  if (chip.kind === 'commit') return chip.label.replace(/^Commit/, '提交');
  if (chip.kind === 'conversation') return fullTitle(chip, true);
  if (chip.kind === 'quote') return chip.label.replace(/^Quote:/, '引用：');
  if (chip.kind === 'session') return chip.label.replace(/^Session/, '会话');
  if (chip.kind === 'agent') return chip.label.replace(/^Agent/, '代理');
  if (chip.kind === 'skill') return chip.label.replace(/^Skill/, '技能');
  return chip.label;
}

function fullTitle(chip: Chip, zh: boolean) {
  if (!zh) return chip.title;
  if (chip.kind === 'file') return chip.title.replace(/^File:/, '文件：');
  if (chip.kind === 'commit') return chip.title.replace(/^Commit/, '提交');
  if (chip.kind === 'quote') return chip.title.replace(/^Quote:/, '引用：');
  if (chip.kind === 'diff') return chip.title.replace(/^Uncommitted diff/, '未提交差异').replace('(unstaged', '（未暂存').replace('(staged', '（已暂存').replace('; truncated', '；已截断').replace(/\)$/, '）');
  if (chip.kind === 'conversation') return chip.title.replace(/^Conversation up to/, '复制至').replace(' (copied)', ' 的对话');
  if (chip.kind === 'session') return chip.title.replace(/^Session ([A-Za-z0-9._:-]+):/, '$1 会话：').replace(/\. Call session_info with this id\.$/, '。请用此 ID 调用 session_info。').replace(/\. Summary attached; session_info unavailable\.$/, '。已附加摘要；session_info 不可用。');
  if (chip.kind === 'agent') return chip.title.replace(/^Agent: delegate the following task to (.+) with delegate_start\.$/, '代理：用 delegate_start 将后续任务交给 $1。');
  if (chip.kind === 'skill') return chip.title.replace(/^Skill: (.+?) \(invoke: (.+)\)$/, '技能：$1（调用：$2）');
  return chip.title.replace(/^Terminal output/, '终端输出').replace(/, last (\d+) lines$/, '，最后 $1 行');
}

function ContextChips({ chips, zh, remove, disabled, children }: { chips: Chip[]; zh: boolean; remove?: (id: string) => void; disabled?: boolean; children?: ReactNode }) {
  const [preview, setPreview] = useState<Chip | 'all'>();
  const [shown, setShown] = useState(chips.length);
  const measure = useRef<HTMLDivElement>(null);
  const copy = (en: string, cn: string) => zh ? cn : en;
  useLayoutEffect(() => {
    const node = measure.current;
    if (!node) return;
    const fit = () => {
      const width = node.clientWidth;
      if (!width) return;
      const widths = Array.from(node.children).map(child => (child as HTMLElement).offsetWidth);
      const moreWidth = widths.pop() ?? 80;
      const fits = (count: number) => {
        let row = 1, used = 0;
        const values = widths.slice(0, count);
        if (count < chips.length) values.push(moreWidth);
        for (const value of values) {
          const next = Math.min(value, width);
          if (used && used + 6 + next > width) { row++; used = 0; }
          used += (used ? 6 : 0) + next;
        }
        return row <= 2;
      };
      let count = chips.length;
      while (count > 0 && !fits(count)) count--;
      setShown(count);
    };
    fit(); const observer = new ResizeObserver(fit); observer.observe(node);
    return () => observer.disconnect();
  }, [chips]);
  if (!chips.length) return null;
  const label = (chip: Chip) => localized(chip, zh);
  return <>
    <div className="context-chips-wrap">
      <div className="context-chip-measure" ref={measure} aria-hidden="true">{chips.map(chip => <span className="context-chip" key={chip.id}><span className="btn btn-sm context-chip-label"><Icon name={icons[chip.kind]}/>{label(chip)}</span>{remove && <span className="icon-btn icon-btn-sm context-chip-remove"><Icon name="close"/></span>}</span>)}<span className="btn btn-sm btn-ghost context-more">{copy(`+${chips.length} more`, `+${chips.length} 项`)}</span></div>
      <div className="context-chips">{chips.slice(0, shown).map(chip => <span className="context-chip" key={chip.id}>
        <button type="button" className="btn btn-sm context-chip-label" title={fullTitle(chip,zh)} aria-label={fullTitle(chip,zh)} data-testid="context-chip" onClick={() => setPreview(chip)}><Icon name={icons[chip.kind]}/><span>{label(chip)}</span></button>
        {remove && <button type="button" className="icon-btn icon-btn-sm context-chip-remove" disabled={disabled} title={copy('Remove context', '移除上下文')} aria-label={copy(`Remove context: ${label(chip)}`, `移除上下文：${label(chip)}`)} data-testid="context-chip-remove" onClick={() => remove(chip.id)}><Icon name="close"/></button>}
      </span>)}{shown < chips.length && <button type="button" className="btn btn-sm btn-ghost context-more" onClick={() => setPreview('all')}>{copy(`+${chips.length - shown} more`, `+${chips.length - shown} 项`)}</button>}</div>
    </div>
    {children}
    {preview && <SurfaceDialog title={copy('Context preview', '上下文预览')} variant="plain" size="wide" className="context-preview-dialog" onClose={() => setPreview(undefined)}>
      {preview === 'all' ? <div className="context-preview-list">{chips.map(chip => <section key={chip.id}><div className="context-preview-list-head"><button type="button" className="btn-subtle" onClick={() => setPreview(chip)}>{label(chip)}</button>{remove && <button type="button" className="btn-subtle" disabled={disabled} onClick={() => remove(chip.id)}>{copy('Remove context', '移除上下文')}</button>}</div><pre className="context-preview" data-testid="context-preview">{chip.block}</pre></section>)}</div> : <pre className="context-preview" data-testid="context-preview">{preview.block}</pre>}
    </SurfaceDialog>}
  </>;
}

function chipsFor(blocks: string[], ids?: string[]): Chip[] {
  return blocks.flatMap((block, index) => {
    const header = block.split('\n', 1)[0];
    const metadata = contextDisplayMetadata(header);
    return metadata ? [{ ...metadata, id: ids?.[index] ?? String(index), block }] : [];
  });
}

export function ContextTray({ items, text, zh, onRemove, disabled }: { items: ContextItem[]; text: string; zh: boolean; onRemove: (id: string) => void; disabled?: boolean }) {
  if (!items.length) return null;
  const blocks = contextSerializedBlocks(items);
  let bytes: number;
  try { bytes = new TextEncoder().encode(serializeContext(items, text.trim())).length; }
  catch { bytes = new TextEncoder().encode(blocks.join('\n') + '\n[ThreadTerm message]\n' + text.trim()).length; }
  return <div className="context-tray" data-testid="context-tray" aria-label={zh ? '消息上下文' : 'Message context'}><ContextChips chips={chipsFor(blocks, items.map(item => item.id))} zh={zh} remove={onRemove} disabled={disabled}>
    {(items.length > 9 || bytes > 96 * 1024) && <span className="context-budget" role="status">{zh ? `${items.length}/12 · ${Math.ceil(bytes / 1024)} KiB / 128 KiB` : `${items.length}/12 · ${Math.ceil(bytes / 1024)} KiB of 128 KiB`}</span>}
  </ContextChips></div>;
}

/** Shared by submitted user bubbles and the pending-send preview. */
export function ContextMessage({ text, zh, children }: { text: string; zh: boolean; children: (text: string) => ReactNode }) {
  const parsed = parseContext(text);
  if (!parsed) return <>{children(text)}</>;
  const blocks = parsed.items.map(({ header, body }) => header + (body ? `\n${body}` : ''));
  return <><div className="context-transcript-row" data-testid="context-transcript-row"><ContextChips chips={chipsFor(blocks)} zh={zh}/></div>{children(parsed.text)}</>;
}

export function ContextQueueBadge({ text, zh }: { text: string; zh: boolean }) {
  const [open, setOpen] = useState(false);
  const parsed = parseContext(text);
  if (!parsed) return null;
  return <><button type="button" className="chat-queue-context-badge" data-testid="chat-queue-context-badge" onClick={() => setOpen(true)}>{zh ? `${parsed.items.length} 项上下文` : `${parsed.items.length} context`}</button>{open && <SurfaceDialog title={zh ? '上下文预览' : 'Context preview'} variant="plain" size="wide" onClose={() => setOpen(false)}><pre className="context-preview" data-testid="context-preview">{parsed.items.map(({ header, body }) => header + (body ? `\n${body}` : '')).join('\n')}</pre></SurfaceDialog>}</>;
}
