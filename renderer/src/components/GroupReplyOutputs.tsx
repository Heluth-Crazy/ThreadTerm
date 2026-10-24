import type { GroupMessage } from '@threadterm/protocol';
import { Icon } from './PrototypeIcon';
import type { GroupCopy } from './GroupStatus';
import { baseName, parentPath } from '../workbench/types';

type Props={message:GroupMessage;copy:GroupCopy;onOpenFile:(path:string)=>void;onOpenUrl:(url:string)=>void};

export function ReplyOutputs({ message, copy, onOpenFile, onOpenUrl }: Props) {
  if (!message.outputs) return null;
  const changedDetails=message.outputs.changedDetails ?? message.outputs.changed.map(path => ({ path, status:'changed' as const, evidence:'tool' as const }));
  const deletedDetails=new Map(changedDetails.filter(detail => detail.status === 'deleted').map(detail => [detail.path, detail]));
  const possibleWriterHandles=message.outputs.possiblyChangedWith ?? [];
  const possibleWriters=possibleWriterHandles.map(handle => handle === 'you' ? copy('you', '你') : `@${handle}`).join(', ');
  const possibleTitle=possibleWriters
    ? copy(`Changed while ${possibleWriters}${possibleWriterHandles.length === 1 && possibleWriterHandles[0] !== 'you' ? ' was' : ' were'} also working`, `${possibleWriters} 同时工作时发生更改`)
    : copy('Changed while another member was also working', '另一位成员同时工作时发生更改');
  const evidenceTitle=(evidence:'tool'|'folder') => evidence === 'folder'
    ? copy('found by comparing the folder before and after the turn', '通过比较此轮前后的文件夹发现')
    : copy("Reported by the agent's file tool", '由 Agent 的文件工具报告');
  const statusLabel=(status:'added'|'modified'|'deleted'|'changed') => copy(
    status === 'added' ? 'Added' : status === 'deleted' ? 'Deleted' : status === 'modified' ? 'Modified' : 'Changed',
    status === 'added' ? '已添加' : status === 'deleted' ? '已删除' : status === 'modified' ? '已修改' : '已更改',
  );
  const statusLetter=(status:'added'|'modified'|'deleted'|'changed') => status === 'added' ? 'A' : status === 'modified' ? 'M' : status === 'deleted' ? 'D' : undefined;
  const detailTitle=(detail:typeof changedDetails[number]) => detail.status === 'changed'
    ? evidenceTitle(detail.evidence)
    : `${statusLabel(detail.status)} · ${evidenceTitle(detail.evidence)}`;
  const tone=(status:'added'|'modified'|'deleted'|'changed') => status === 'changed' ? '' : ` tone-${status}`;
  return (
    <div className="gc-outputs">
      <div className="gc-output-chips">
        {message.outputs.files.map(path => {
          const deleted=deletedDetails.get(path);
          return deleted ? (
            <span className="chip is-plain gc-output-deleted" data-output-path={path} key={path}
              title={`${path} · ${statusLabel(deleted.status)} · ${evidenceTitle(deleted.evidence)}`}>
              <Icon name="file" /><span>{path}</span>
            </span>
          ) : (
            <button className="chip chip-btn is-plain" data-output-path={path} key={path} title={path} onClick={() => onOpenFile(path)}>
              <Icon name="file" /><span>{path}</span>
            </button>
          );
        })}
        {message.outputs.urls.map(url => (
          <button className="chip chip-btn is-plain" data-output-url={url} title={url} key={url} onClick={() => onOpenUrl(url)}>
            <Icon name="globe" /><span>{url}</span>
          </button>
        ))}
      </div>
      {(!!changedDetails.length || message.outputs.changedIncomplete) && (
        <details>
          <summary title={message.outputs.changedIncomplete ? copy('Some changes may be missing (folder too large to compare)', '可能缺少部分更改（文件夹过大，无法比较）') : undefined}>
            {copy(`Changed: ${changedDetails.length} file${changedDetails.length === 1 ? '' : 's'}`, `已更改 ${changedDetails.length} 个文件`)}{message.outputs.changedIncomplete && <span className="gc-changed-incomplete">{copy(' · some changes may be missing', ' · 可能缺少部分更改')}</span>}
          </summary>
          <div className="gc-changed-list" role="list">{changedDetails.map(detail => {
            const title=detailTitle(detail), letter=statusLetter(detail.status);
            const content=<><Icon name="file"/><span className="wb-name">{baseName(detail.path)}</span><span className="wb-dir">{parentPath(detail.path)}</span></>;
            return <div key={`${detail.path}:${detail.status}`} role="listitem" data-change-status={detail.status} className={`wb-change-row${tone(detail.status)}`}>
              {detail.status === 'deleted'
                ? <span className="wb-change-open gc-change-static" title={title} aria-label={`${detail.path}: ${title}`}>{content}</span>
                : <button type="button" className="wb-change-open" title={title} aria-label={`${detail.path}: ${title}`} onClick={() => onOpenFile(detail.path)}>{content}</button>}
              {letter && <span className="wb-deco" aria-hidden="true">{letter}</span>}
            </div>;
          })}</div>
        </details>
      )}
      {!!message.outputs.possiblyChanged?.length && (
        <details className="gc-possibly-changed">
          <summary title={possibleTitle}>{copy(`Possibly changed (${message.outputs.possiblyChanged.length})`, `可能已更改（${message.outputs.possiblyChanged.length}）`)}</summary>
          <div className="gc-possibly-list" role="list">{message.outputs.possiblyChanged.map(path => (
            <div key={path} role="listitem" className="wb-change-row" title={possibleTitle} aria-label={`${path}: ${possibleTitle}`}>
              <span className="wb-change-open gc-change-static"><Icon name="file"/><span className="wb-name">{baseName(path)}</span><span className="wb-dir">{parentPath(path)}</span></span>
            </div>
          ))}</div>
        </details>
      )}
    </div>
  );
}
