import {
  FileCode2,
  GitCompare,
  Plus,
  SquareTerminal,
} from 'lucide-react';
import type { CardMeta } from '@shared/mobile/bridge/protocol';
import type { WorkspaceDraftMeta, WorkspaceTab } from '@shared/lib/workspace/types';
import { useI18n } from '../i18n';

export interface WorkspaceHomeProps {
  projectName: string;
  worktreePath: string;
  branchLabel?: string | null;
  cards: CardMeta[];
  tabs: WorkspaceTab[];
  draftMetas: WorkspaceDraftMeta[];
  secureReady: boolean;
  canMutate: boolean;
  readOnly: boolean;
  onOpenTerminal: (cardId: string) => void;
  onOpenTab: (tabId: string) => void;
  onOpenFileBrowser?: () => void;
  onNewTerminal?: () => void;
}

export function WorkspaceHome({
  projectName,
  worktreePath,
  branchLabel,
  cards,
  tabs,
  draftMetas,
  secureReady,
  canMutate,
  readOnly,
  onOpenTerminal,
  onOpenTab,
  onOpenFileBrowser,
  onNewTerminal,
}: WorkspaceHomeProps) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const fileTabs = tabs.filter((tab) => tab.kind === 'file' || tab.kind === 'diff');
  const dirtyCount = draftMetas.filter((meta) => meta.dirty).length;

  return (
    <div className="workspace-home" data-testid="workspace-home">
      <section className="workspace-home-identity">
        <h2>{projectName}</h2>
        {branchLabel && <span className="workspace-branch">{branchLabel}</span>}
        <p className="breakable-path">{worktreePath}</p>
        <p className="workspace-home-meta">
          {secureReady
            ? zh
              ? '安全工作区 · 共享标签由桌面权威维护'
              : 'Secure workspace · shared tabs owned by desktop'
            : zh
              ? '旧版终端模式 · 仅终端；文件/Diff 需安全 v2'
              : 'Legacy terminal mode · terminals only; files/Diff need secure v2'}
          {readOnly ? (zh ? ' · 只读' : ' · read-only') : ''}
        </p>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>{zh ? '终端' : 'Terminals'}</h2>
          <span>{cards.length}</span>
        </div>
        {cards.length === 0 ? (
          <div className="workbench-empty-state compact">
            <SquareTerminal size={20} />
            <strong>{zh ? '此工作树还没有终端' : 'No terminals in this worktree'}</strong>
            {canMutate && onNewTerminal && (
              <button type="button" onClick={onNewTerminal}>
                <Plus size={16} />
                {zh ? '新建终端' : 'New terminal'}
              </button>
            )}
          </div>
        ) : (
          <div className="ios-list-card">
            {cards.map((card) => (
              <button
                key={card.id}
                type="button"
                className="workspace-home-row"
                onClick={() => onOpenTerminal(card.id)}
              >
                <SquareTerminal size={18} />
                <span>
                  <strong>{card.terminalType || card.projectName}</strong>
                  <small>
                    {card.status}
                    {card.summaryLine ? ` · ${card.summaryLine}` : ''}
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>{zh ? '文件与 Diff' : 'Files & Diff'}</h2>
          <span>{fileTabs.length}</span>
        </div>
        {!secureReady ? (
          <div className="mobile-info-card warning" data-testid="workspace-files-blocked">
            <strong>{zh ? '需要安全工作区连接' : 'Secure workspace required'}</strong>
            <span>
              {zh
                ? '文件、Diff 与草稿只通过带证书指纹的安全 v2 传输，不会走旧版明文通道。'
                : 'Files, Diff, and drafts only travel over secure v2 with cert fingerprint — never plaintext v1.'}
            </span>
          </div>
        ) : (
          <>
            {dirtyCount > 0 && (
              <p className="workspace-home-meta">
                {zh ? `${dirtyCount} 个未保存草稿（仅桌面持久化）` : `${dirtyCount} unsaved draft(s) — desktop only`}
              </p>
            )}
            {fileTabs.length === 0 ? (
              <div className="workbench-empty-state compact">
                <FileCode2 size={20} />
                <strong>{zh ? '尚未打开文件标签' : 'No file tabs open'}</strong>
                {onOpenFileBrowser && (
                  <button type="button" onClick={onOpenFileBrowser} disabled={readOnly && false}>
                    {zh ? '浏览文件' : 'Browse files'}
                  </button>
                )}
              </div>
            ) : (
              <div className="ios-list-card">
                {fileTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className="workspace-home-row"
                    onClick={() => onOpenTab(tab.id)}
                  >
                    {tab.kind === 'diff' ? <GitCompare size={18} /> : <FileCode2 size={18} />}
                    <span>
                      <strong>{tab.title}</strong>
                      <small>{tab.relativePath || tab.kind}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
