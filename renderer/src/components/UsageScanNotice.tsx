import type { usageScanNotice } from '../usageScan';

export function UsageScanNotice({ notice, onAction }: { notice: NonNullable<ReturnType<typeof usageScanNotice>>; onAction: () => void }) {
  return <div className={`usage-scan-notice ${notice.kind === 'failed' ? 'surface-error' : 'stalled-note'}`}
    role={notice.kind === 'failed' ? 'alert' : 'status'} aria-live={notice.kind === 'failed' ? 'assertive' : notice.kind === 'running' ? 'off' : 'polite'}>
    <div>
      <strong className="usage-scan-title">{notice.title}</strong>
      {notice.detail && <p>{notice.detail}</p>}
      {notice.code && <code className="usage-scan-code">{notice.code}</code>}
    </div>
    <button type="button" className="btn btn-sm" onClick={onAction}>{notice.action}</button>
  </div>;
}
