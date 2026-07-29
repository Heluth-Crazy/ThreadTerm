import { ChevronRight, GitBranch, SquareTerminal } from 'lucide-react';
import type {
  CardMeta,
  MobileAttentionItem,
  MobileExecutionGroup,
} from '@shared/mobile/bridge/protocol';
import { useI18n } from '../i18n';
import {
  AttentionCard,
  DetailField,
  DetailScaffold,
  WorkbenchEmptyState,
} from './workbenchComponents';
import {
  formatRelativeTime,
  groupStatusLabel,
  worktreeLabel,
} from './workbenchPresentation';

export function ExecutionGroupDetailScreen({
  cards,
  group,
  onBack,
  onOpenAttention,
  onOpenTerminal,
  relatedAttention,
}: {
  cards: CardMeta[];
  group: MobileExecutionGroup | null;
  onBack: () => void;
  onOpenAttention: (id: string) => void;
  onOpenTerminal: (cardId: string) => void;
  relatedAttention: MobileAttentionItem[];
}) {
  const { language } = useI18n();
  const zh = language === 'zh';
  if (!group) {
    return (
      <DetailScaffold
        title={zh ? '执行上下文' : 'Execution context'}
        onBack={onBack}
      >
        <WorkbenchEmptyState
          icon={<GitBranch size={22} />}
          title={zh ? '执行上下文已消失' : 'Context no longer exists'}
          copy={
            zh
              ? '返回工作台刷新当前快照。'
              : 'Return to Workbench to refresh.'
          }
        />
      </DetailScaffold>
    );
  }
  const groupCards = group.cardIds
    .map((id) => cards.find((card) => card.id === id))
    .filter((card): card is CardMeta => Boolean(card));

  return (
    <DetailScaffold
      title={zh ? '执行上下文' : 'Execution context'}
      onBack={onBack}
    >
      <article className="detail-hero">
        <span className={`semantic-pill status-${group.status}`}>
          {groupStatusLabel(group.status, zh)}
        </span>
        <h2>{group.projectName}</h2>
        <p className="breakable-path">{group.projectPath}</p>
        <div className="detail-grid">
          <DetailField label="Worktree" value={worktreeLabel(group)} />
          <DetailField
            label={zh ? '最近活动' : 'Last activity'}
            value={formatRelativeTime(group.lastActivity, zh)}
          />
          <DetailField
            label={zh ? '终端数量' : 'Terminals'}
            value={String(group.terminalCount)}
          />
          <DetailField
            label={zh ? '需关注' : 'Attention'}
            value={String(group.attentionCount)}
          />
        </div>
        {group.preview && <div className="evidence-box">{group.preview}</div>}
      </article>

      {relatedAttention.length > 0 && (
        <section className="mobile-section">
          <div className="mobile-section-heading">
            <h2>
              {zh ? '相关事项' : 'Related signals'}{' '}
              <span className="count-badge">{relatedAttention.length}</span>
            </h2>
          </div>
          <div className="mobile-stack">
            {relatedAttention.map((item) => (
              <AttentionCard
                key={item.id}
                item={item}
                zh={zh}
                onOpen={() => onOpenAttention(item.id)}
              />
            ))}
          </div>
        </section>
      )}

      <section className="mobile-section">
        <div className="mobile-section-heading">
          <h2>
            {zh ? '终端' : 'Terminals'}{' '}
            <span className="count-badge">{groupCards.length}</span>
          </h2>
        </div>
        <div className="mobile-list-card">
          {groupCards.length > 0 ? (
            groupCards.map((card) => (
              <button
                className="detail-terminal-row"
                type="button"
                key={card.id}
                onClick={() => onOpenTerminal(card.id)}
              >
                <SquareTerminal size={20} />
                <span>
                  <strong>{card.projectName || card.id}</strong>
                  <small>
                    {card.terminalType || 'shell'} ·{' '}
                    {card.summaryLine ||
                      card.lastReplyPreview ||
                      card.projectPath}
                  </small>
                </span>
                <ChevronRight size={17} />
              </button>
            ))
          ) : (
            <WorkbenchEmptyState
              icon={<SquareTerminal size={22} />}
              title={zh ? '没有可见终端' : 'No visible terminals'}
              copy={
                zh ? '终端可能已关闭。' : 'The terminal may have been closed.'
              }
            />
          )}
        </div>
      </section>
    </DetailScaffold>
  );
}
