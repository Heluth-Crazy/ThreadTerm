import { useEffect, useRef } from 'react';
import { AlertTriangle, FileWarning, X } from 'lucide-react';
import type { DirtyCloseChoice } from './types';
import { useI18n } from '../i18n';

export interface DirtyFileCloseSheetProps {
  open: boolean;
  titles: string[];
  conflict?: boolean;
  /** Full control required for save/discard. */
  canMutate: boolean;
  onChoose: (choice: DirtyCloseChoice) => void;
}

export function DirtyFileCloseSheet({
  open,
  titles,
  conflict = false,
  canMutate,
  onChoose,
}: DirtyFileCloseSheetProps) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const defaultRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    defaultRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onChoose('cancel');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose, open]);

  if (!open) return null;

  return (
    <div className="mobile-sheet-root" data-testid="dirty-file-close-sheet">
      <button
        type="button"
        className="mobile-sheet-backdrop"
        aria-label={zh ? '取消' : 'Cancel'}
        onClick={() => onChoose('cancel')}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dirty-close-title"
        className="mobile-sheet-panel"
      >
        <header className="mobile-sheet-header">
          <span className="mobile-sheet-icon warning">
            {conflict ? <AlertTriangle size={18} /> : <FileWarning size={18} />}
          </span>
          <h2 id="dirty-close-title">
            {conflict
              ? zh
                ? '文件冲突'
                : 'File conflict'
              : zh
                ? '未保存的更改'
                : 'Unsaved changes'}
          </h2>
          <button type="button" className="mobile-icon-button" onClick={() => onChoose('cancel')} aria-label={zh ? '关闭' : 'Close'}>
            <X size={18} />
          </button>
        </header>
        <div className="mobile-sheet-body">
          {conflict ? (
            <p>
              {zh
                ? '磁盘内容在草稿打开期间已变化。请先解决冲突再关闭。'
                : 'Disk content changed while a draft was open. Resolve the conflict before closing.'}
            </p>
          ) : (
            <p>
              {titles.length === 1
                ? zh
                  ? '关闭前保存更改，还是丢弃？'
                  : 'Save changes before closing, or discard them?'
                : zh
                  ? `关闭前保存或丢弃 ${titles.length} 个标签中的更改？`
                  : `Save or discard changes in ${titles.length} tabs before closing?`}
            </p>
          )}
          {titles.length > 0 && (
            <ul className="mobile-sheet-file-list">
              {titles.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          )}
          {!canMutate && !conflict && (
            <p className="mobile-info-card warning compact" data-testid="dirty-close-readonly">
              {zh
                ? '只读设备不能保存或丢弃草稿。请在桌面端处理，或保持标签打开。'
                : 'Read-only devices cannot save or discard drafts. Keep the tab open or use desktop.'}
            </p>
          )}
        </div>
        <footer className="mobile-sheet-actions">
          <button type="button" className="sheet-btn ghost" onClick={() => onChoose('cancel')}>
            {zh ? '取消' : 'Cancel'}
          </button>
          {!conflict && canMutate && (
            <>
              <button
                type="button"
                className="sheet-btn danger"
                onClick={() => onChoose('discardAndClose')}
                data-testid="dirty-discard-and-close"
              >
                {zh ? '丢弃并关闭' : 'Discard and close'}
              </button>
              <button
                ref={defaultRef}
                type="button"
                className="sheet-btn primary"
                onClick={() => onChoose('saveAndClose')}
                data-testid="dirty-save-and-close"
              >
                {zh ? '保存并关闭' : 'Save and close'}
              </button>
            </>
          )}
          {(conflict || !canMutate) && (
            <button
              ref={defaultRef}
              type="button"
              className="sheet-btn primary"
              onClick={() => onChoose('cancel')}
              data-testid="dirty-keep-open"
            >
              {zh ? '保持打开' : 'Keep open'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
