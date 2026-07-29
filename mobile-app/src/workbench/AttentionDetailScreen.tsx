import { CircleAlert, SquareTerminal } from 'lucide-react';
import type { MobileAttentionItem } from '@shared/mobile/bridge/protocol';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';
import { useI18n } from '../i18n';
import {
  DetailField,
  DetailScaffold,
  WorkbenchEmptyState,
} from './workbenchComponents';
import {
  attentionKindLabel,
  formatRelativeTime,
  pathLeaf,
  reasonLabel,
  sourceLabel,
} from './workbenchPresentation';

export function AttentionDetailScreen({
  item,
  onBack,
  onOpenTerminal,
  terminalAvailable,
  wsStatus,
}: {
  item: MobileAttentionItem | null;
  onBack: () => void;
  onOpenTerminal: (cardId: string) => void;
  terminalAvailable: boolean;
  wsStatus: BridgeConnectionState;
}) {
  const { language } = useI18n();
  const zh = language === 'zh';
  if (!item) {
    return (
      <DetailScaffold title={zh ? '事项详情' : 'Signal details'} onBack={onBack}>
        <WorkbenchEmptyState
          icon={<CircleAlert size={22} />}
          title={zh ? '事项已消失' : 'Signal no longer exists'}
          copy={
            zh
              ? '它可能已在桌面端处理，请返回刷新当前快照。'
              : 'It may have been handled on desktop.'
          }
        />
      </DetailScaffold>
    );
  }

  const desktopRequired = item.sourceKind === 'structured_request';
  const canOpen =
    terminalAvailable && wsStatus === 'open' && item.capability.openTerminal;

  return (
    <DetailScaffold
      title={zh ? '事项详情' : 'Signal details'}
      onBack={onBack}
      footer={
        <div className="detail-footer">
          {desktopRequired && (
            <div className="mobile-info-card warning">
              <strong>
                {zh ? '需要桌面端确认' : 'Desktop confirmation required'}
              </strong>
              <span>
                {zh
                  ? '移动 Bridge 暂不直接响应结构化审批，可打开终端查看上下文。'
                  : 'Mobile Bridge does not answer structured approvals directly.'}
              </span>
            </div>
          )}
          <button
            className="primary-full-button"
            type="button"
            disabled={!canOpen}
            onClick={() => onOpenTerminal(item.cardId)}
          >
            <SquareTerminal size={18} />
            {canOpen
              ? zh
                ? '打开终端处理'
                : 'Open terminal'
              : zh
                ? '当前无法打开终端'
                : 'Terminal unavailable'}
          </button>
        </div>
      }
    >
      <article className={`detail-hero severity-${item.severity}`}>
        <span className={`semantic-pill kind-${item.kind}`}>
          {attentionKindLabel(item.kind, zh)}
        </span>
        <h2>{item.title}</h2>
        {item.detail && <p>{item.detail}</p>}
        <div className="detail-grid">
          <DetailField
            label={zh ? '来源' : 'Source'}
            value={sourceLabel(item.sourceKind, zh)}
          />
          <DetailField
            label={zh ? '出现时间' : 'Occurred'}
            value={formatRelativeTime(item.occurredAt, zh)}
          />
          <DetailField label={zh ? '项目' : 'Project'} value={item.projectName} />
          <DetailField
            label="Worktree"
            value={
              item.branchLabel ||
              pathLeaf(item.worktreePath || item.projectPath)
            }
          />
        </div>
        <div className="evidence-box">
          <strong>{zh ? '确定性原因' : 'Deterministic reason'}</strong>
          <span>{reasonLabel(item.reasonCode, zh)}</span>
        </div>
      </article>
      <div className="mobile-info-card">
        <strong>{zh ? '处理边界' : 'Action boundary'}</strong>
        <span>
          {zh
            ? '这里仅展示证据并导航，不执行批准、输入、重启或文件写入。'
            : 'This view provides evidence and navigation only.'}
        </span>
      </div>
    </DetailScaffold>
  );
}
