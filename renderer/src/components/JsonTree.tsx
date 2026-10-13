import { useState } from 'react';
import { jsonView } from '../toolCards';
import { Icon } from './PrototypeIcon';

type Copy = (en: string, zh: string) => string;

/** Collapsible JSON tree for MCP and generic tool arguments/results (F5 reuses it). */
export function JsonTree({ value, copy }: { value: unknown; copy: Copy }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [raw, setRaw] = useState(false);
  const view = jsonView(value, expanded, collapsed);
  const toggle = (path: string, open: boolean) => {
    setExpanded(current => {
      const next = new Set(current);
      if (open) next.delete(path); else next.add(path);
      return next;
    });
    setCollapsed(current => {
      const next = new Set(current);
      if (open) next.add(path); else next.delete(path);
      return next;
    });
  };
  if (raw) return <div className="tool-json" data-json-raw="true">
    <div className="tool-json-bar"><button type="button" className="btn btn-sm tool-card-action" onClick={() => setRaw(false)}>{copy('Tree', '树形')}</button></div>
    <pre className="tool-json-raw">{JSON.stringify(value, null, 2)}</pre>
  </div>;
  return <div className="tool-json" data-json-nodes={view.nodes}>
    <div className="tool-json-bar">
      <button type="button" className="btn btn-sm tool-card-action" onClick={() => setRaw(true)}>{copy('Raw', '原始')}</button>
    </div>
    <div className="tool-json-tree" role="group" aria-label={copy('JSON values', 'JSON 数据')}>
      {view.rows.map(row => <div className="tool-json-row" key={row.path} style={{ paddingLeft: row.depth * 14 }}>
        {row.expandable
          ? <button type="button" className="icon-btn icon-btn-sm tool-json-toggle" onClick={() => toggle(row.path, row.expanded)} aria-expanded={row.expanded} aria-label={row.expanded ? copy(`Collapse ${row.path}`, `收起 ${row.path}`) : copy(`Expand ${row.path}`, `展开 ${row.path}`)}><Icon name="chevR" /></button>
          : <span className="tool-json-spacer" aria-hidden="true" />}
        {row.key !== undefined && <span className="tool-json-key">{row.key}:</span>}
        <span className={`tool-json-value is-${row.kind}`}>{row.preview}</span>
      </div>)}
    </div>
    {view.truncated && <button type="button" className="btn btn-sm tool-card-action" onClick={() => setRaw(true)}>{copy('Show raw', '显示原始文本')}</button>}
  </div>;
}
