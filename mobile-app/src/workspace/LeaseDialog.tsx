import { useEffect, useRef } from 'react';
import { Lock, Unlock, X } from 'lucide-react';
import { useI18n } from '../i18n';

export interface LeaseDialogProps {
  open: boolean;
  tabTitle: string;
  holderSurfaceId: string | null;
  /** Full-control devices may takeover; read-only never. */
  canTakeover: boolean;
  busy?: boolean;
  onAcquire: () => void;
  onTakeover: () => void;
  onCancel: () => void;
}

export function LeaseDialog({
  open,
  tabTitle,
  holderSurfaceId,
  canTakeover,
  busy = false,
  onAcquire,
  onTakeover,
  onCancel,
}: LeaseDialogProps) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const defaultRef = useRef<HTMLButtonElement>(null);
  const heldByOther = Boolean(holderSurfaceId);

  useEffect(() => {
    if (!open) return;
    defaultRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="mobile-sheet-root" data-testid="lease-dialog">
      <button type="button" className="mobile-sheet-backdrop" aria-label={zh ? '取消' : 'Cancel'} onClick={onCancel} />
      <div role="dialog" aria-modal="true" aria-labelledby="lease-dialog-title" className="mobile-sheet-panel">
        <header className="mobile-sheet-header">
          <span className="mobile-sheet-icon">
            <Lock size={18} />
          </span>
          <h2 id="lease-dialog-title">{zh ? '编辑权' : 'Edit lease'}</h2>
          <button type="button" className="mobile-icon-button" onClick={onCancel} aria-label={zh ? '关闭' : 'Close'}>
            <X size={18} />
          </button>
        </header>
        <div className="mobile-sheet-body">
          <p>
            {zh ? `文件「${tabTitle}」` : `File “${tabTitle}”`}
            {heldByOther
              ? zh
                ? ` 正由 ${holderSurfaceId} 编辑。`
                : ` is being edited by ${holderSurfaceId}.`
              : zh
                ? ' 当前无人持有编辑权。'
                : ' has no active editor lease.'}
          </p>
          {heldByOther && !canTakeover && (
            <p className="mobile-info-card warning compact" data-testid="lease-takeover-blocked">
              {zh
                ? '只读设备不能接管编辑权。'
                : 'Read-only devices cannot take over the edit lease.'}
            </p>
          )}
        </div>
        <footer className="mobile-sheet-actions">
          <button type="button" className="sheet-btn ghost" onClick={onCancel} disabled={busy}>
            {zh ? '取消' : 'Cancel'}
          </button>
          {!heldByOther && (
            <button
              ref={defaultRef}
              type="button"
              className="sheet-btn primary"
              onClick={onAcquire}
              disabled={busy || !canTakeover}
              data-testid="lease-acquire"
            >
              <Unlock size={15} />
              {zh ? '获取编辑权' : 'Acquire lease'}
            </button>
          )}
          {heldByOther && canTakeover && (
            <button
              ref={defaultRef}
              type="button"
              className="sheet-btn danger"
              onClick={onTakeover}
              disabled={busy}
              data-testid="lease-takeover"
            >
              {zh ? '接管编辑' : 'Take over editing'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
