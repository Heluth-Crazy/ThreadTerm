import { useEffect, useRef } from 'react';
import { AlertTriangle, Copy, X } from 'lucide-react';
import { useI18n } from '../i18n';

export type ConflictResolution = 'keep_draft' | 'use_disk' | 'copy_unsynced' | 'cancel';

export interface ConflictDialogProps {
  open: boolean;
  title: string;
  draftPreview: string;
  diskPreview: string;
  canResolve: boolean;
  onChoose: (choice: ConflictResolution) => void;
}

function preview(text: string, max = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function ConflictDialog({
  open,
  title,
  draftPreview,
  diskPreview,
  canResolve,
  onChoose,
}: ConflictDialogProps) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const defaultRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    defaultRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="mobile-sheet-root" data-testid="conflict-dialog">
      <button type="button" className="mobile-sheet-backdrop" aria-label={zh ? '取消' : 'Cancel'} onClick={() => onChoose('cancel')} />
      <div role="dialog" aria-modal="true" aria-labelledby="conflict-title" className="mobile-sheet-panel wide">
        <header className="mobile-sheet-header">
          <span className="mobile-sheet-icon warning">
            <AlertTriangle size={18} />
          </span>
          <h2 id="conflict-title">{zh ? '解决冲突' : 'Resolve conflict'}</h2>
          <button type="button" className="mobile-icon-button" onClick={() => onChoose('cancel')} aria-label={zh ? '关闭' : 'Close'}>
            <X size={18} />
          </button>
        </header>
        <div className="mobile-sheet-body">
          <p>
            {zh
              ? `「${title}」的草稿与磁盘版本不一致。手机不会本地保存源码；选择将发送到桌面端解决。`
              : `Draft for “${title}” disagrees with disk. Mobile never stores source; the choice is sent to desktop.`}
          </p>
          <div className="conflict-compare">
            <section>
              <h3>{zh ? '恢复稿' : 'Draft'}</h3>
              <pre>{preview(draftPreview)}</pre>
            </section>
            <section>
              <h3>{zh ? '磁盘版' : 'On disk'}</h3>
              <pre>{preview(diskPreview)}</pre>
            </section>
          </div>
        </div>
        <footer className="mobile-sheet-actions">
          <button type="button" className="sheet-btn ghost" onClick={() => onChoose('cancel')}>
            {zh ? '取消' : 'Cancel'}
          </button>
          <button
            type="button"
            className="sheet-btn ghost"
            onClick={() => onChoose('copy_unsynced')}
            data-testid="conflict-copy"
          >
            <Copy size={14} />
            {zh ? '复制未同步文本' : 'Copy unsynced text'}
          </button>
          {canResolve && (
            <>
              <button
                type="button"
                className="sheet-btn danger"
                onClick={() => onChoose('use_disk')}
                data-testid="conflict-use-disk"
              >
                {zh ? '使用磁盘版' : 'Use disk version'}
              </button>
              <button
                ref={defaultRef}
                type="button"
                className="sheet-btn primary"
                onClick={() => onChoose('keep_draft')}
                data-testid="conflict-keep-draft"
              >
                {zh ? '保留恢复稿' : 'Keep draft'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
