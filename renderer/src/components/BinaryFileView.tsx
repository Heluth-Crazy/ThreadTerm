import { fileLocationMenuItem, type FileLocationTarget } from '../fileLocation';
import { Icon } from './PrototypeIcon';
import './binary-file-view.css';

/* A file that is not text (a .jar, a .zip, a program): nothing to preview, so the way out is its folder. */
export function BinaryFileView({ path, target, zh, onIssue }: { path: string; target: FileLocationTarget; zh: boolean; onIssue?: (message: string) => void }) {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  const reveal = fileLocationMenuItem(target, zh, onIssue);
  return <section className="binary-file-view" data-testid="binary-file-view" aria-label={name}>
    <div className="binary-file-card">
      <span className="binary-file-glyph" aria-hidden="true"><Icon name="archive" /></span>
      <strong className="binary-file-name" title={path}>{name}</strong>
      <p className="binary-file-note">{zh ? '这个文件不是文本，无法在这里预览。' : "This file isn't text, so it can't be previewed here."}</p>
      <code className="binary-file-path" title={path}>{path}</code>
      <div className="binary-file-actions">
        <button type="button" className="btn btn-primary" data-testid="binary-file-reveal" disabled={reveal.disabled} title={reveal.reason ?? reveal.label} onClick={() => void reveal.onSelect?.()}><Icon name="folder" />{reveal.label}</button>
        <button type="button" className="btn" data-testid="binary-file-copy-path" onClick={() => void navigator.clipboard.writeText(path)}>{zh ? '复制路径' : 'Copy path'}</button>
      </div>
    </div>
  </section>;
}
