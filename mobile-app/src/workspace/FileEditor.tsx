import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloudOff, CloudUpload, Lock, Save } from 'lucide-react';
import type { FileEditorModel, SyncLabel } from './types';
import { useI18n } from '../i18n';

export interface FileEditorProps {
  model: FileEditorModel;
  onChange: (nextContents: string, baseRevision: number) => void;
  onSave?: () => void;
  onRequestLease?: () => void;
  onCopyUnsynced?: () => void;
}

function syncLabelText(label: SyncLabel, zh: boolean): string {
  switch (label) {
    case 'synced':
      return zh ? '已同步' : 'Synced';
    case 'pending':
      return zh ? '同步中…' : 'Syncing…';
    case 'unsynced':
      return zh ? '未同步' : 'Unsynced';
    case 'conflict':
      return zh ? '冲突' : 'Conflict';
    case 'offline':
      return zh ? '离线' : 'Offline';
    default:
      return label;
  }
}

/**
 * Lightweight mobile file editor.
 * Uses a textarea shell (CodeMirror can be lazy-mounted later on iOS builds).
 * Never writes contents to localStorage / IndexedDB.
 */
export function FileEditor({
  model,
  onChange,
  onSave,
  onRequestLease,
  onCopyUnsynced,
}: FileEditorProps) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [local, setLocal] = useState(model.contents);
  const lastAuthoritative = useRef(model.authoritativeRevision);

  useEffect(() => {
    // Accept server content when authoritative revision advances and we are not
    // holding unsynced local keystrokes.
    if (
      model.authoritativeRevision !== lastAuthoritative.current &&
      !model.unsyncedLocal
    ) {
      setLocal(model.contents);
      lastAuthoritative.current = model.authoritativeRevision;
    }
  }, [model.authoritativeRevision, model.contents, model.unsyncedLocal]);

  const editable = !model.readOnly && model.hasLease && model.syncLabel !== 'conflict';

  const handleChange = useCallback(
    (value: string) => {
      if (!editable) return;
      setLocal(value);
      onChange(value, model.authoritativeRevision);
    },
    [editable, model.authoritativeRevision, onChange],
  );

  const statusClass = useMemo(() => `file-sync file-sync-${model.syncLabel}`, [model.syncLabel]);

  return (
    <div className="file-editor" data-testid="file-editor">
      <header className="file-editor-toolbar">
        <div className="file-editor-title">
          <strong>{model.title}</strong>
          <small className="breakable-path">{model.relativePath}</small>
        </div>
        <div className={statusClass} data-testid="file-sync-label">
          {model.syncLabel === 'unsynced' || model.syncLabel === 'offline' ? (
            <CloudOff size={14} />
          ) : (
            <CloudUpload size={14} />
          )}
          <span>{syncLabelText(model.syncLabel, zh)}</span>
        </div>
        {model.readOnly && (
          <span className="file-editor-pill" data-testid="file-readonly-pill">
            <Lock size={12} />
            {zh ? '只读' : 'Read-only'}
          </span>
        )}
        {!model.hasLease && !model.readOnly && onRequestLease && (
          <button type="button" className="file-editor-action" onClick={onRequestLease} data-testid="file-request-lease">
            {zh ? '获取编辑权' : 'Get edit lease'}
          </button>
        )}
        {model.hasLease && onSave && (
          <button
            type="button"
            className="file-editor-action"
            onClick={onSave}
            disabled={!model.dirty || model.syncLabel === 'offline'}
            data-testid="file-save"
          >
            <Save size={14} />
            {zh ? '保存' : 'Save'}
          </button>
        )}
        {model.unsyncedLocal && onCopyUnsynced && (
          <button type="button" className="file-editor-action" onClick={onCopyUnsynced} data-testid="file-copy-unsynced">
            {zh ? '复制未同步' : 'Copy unsynced'}
          </button>
        )}
      </header>
      {model.leaseHolder && !model.hasLease && (
        <p className="file-editor-lease-banner" data-testid="file-lease-holder">
          {zh ? `编辑权由 ${model.leaseHolder} 持有` : `Lease held by ${model.leaseHolder}`}
        </p>
      )}
      {model.unsyncedLocal && (
        <p className="file-editor-unsynced-banner" data-testid="file-unsynced-banner">
          {zh
            ? '存在未确认输入（仅内存）。断开或杀进程后不会自动恢复，也不会写入本地缓存。'
            : 'Unconfirmed input is memory-only. It is not written to local cache and will not survive process death.'}
        </p>
      )}
      <textarea
        className="file-editor-textarea"
        value={local}
        readOnly={!editable}
        spellCheck={false}
        aria-label={model.title}
        data-testid="file-editor-textarea"
        onChange={(event) => handleChange(event.target.value)}
      />
    </div>
  );
}
