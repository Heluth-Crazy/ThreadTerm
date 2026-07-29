import { SlidersHorizontal } from 'lucide-react';
import type { MobileWorkbenchProjection } from '@shared/mobile/bridge/protocol';
import { useI18n } from '../i18n';
import {
  DetailField,
  DetailScaffold,
  RuleRow,
  WorkbenchEmptyState,
} from './workbenchComponents';

export function RulesScreen({
  onBack,
  projection,
}: {
  onBack: () => void;
  projection: MobileWorkbenchProjection | null;
}) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const rules = projection?.rules;
  return (
    <DetailScaffold
      title={zh ? '注意力规则' : 'Attention rules'}
      onBack={onBack}
    >
      <div className="mobile-info-card warning">
        <strong>{zh ? '由桌面端同步' : 'Synced from desktop'}</strong>
        <span>
          {zh
            ? '移动端只读展示当前生效规则，避免形成第二套判断。'
            : 'Mobile shows the active rules read-only to avoid a second source of truth.'}
        </span>
      </div>
      {rules ? (
        <>
          <section className="mobile-settings-group">
            <h2>{zh ? '信号来源' : 'Signal sources'}</h2>
            <div className="mobile-settings-list">
              <RuleRow
                enabled={rules.includeWaiting}
                label={zh ? '等待用户操作' : 'Waiting for user'}
              />
              <RuleRow
                enabled={rules.includeFailed}
                label={zh ? '异常未恢复' : 'Unrecovered failure'}
              />
              <RuleRow
                enabled={rules.includeCompletedReview}
                label={zh ? '完成待复核' : 'Completed review'}
              />
              <RuleRow
                enabled={rules.stalledEnabled}
                label={zh ? '无进展' : 'Stalled'}
              />
            </div>
          </section>
          <div className="detail-grid">
            <DetailField
              label={zh ? '无进展阈值' : 'Stalled threshold'}
              value={`${rules.stalledThresholdMinutes} ${zh ? '分钟' : 'min'}`}
            />
            <DetailField
              label={zh ? '排除会话' : 'Excluded sessions'}
              value={String(rules.stalledExcludedCount)}
            />
          </div>
        </>
      ) : (
        <WorkbenchEmptyState
          icon={<SlidersHorizontal size={22} />}
          title={zh ? '规则尚未同步' : 'Rules not synced yet'}
          copy={
            zh
              ? '等待桌面端发送 Workbench 投影。'
              : 'Waiting for the desktop Workbench projection.'
          }
        />
      )}
    </DetailScaffold>
  );
}
