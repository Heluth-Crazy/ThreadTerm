import { useState } from 'react';
import { jsonView } from '../toolCards';
import { Icon } from './PrototypeIcon';

type Copy = (en: string, zh: string) => string;

/** Collapsible JSON tree for MCP and generic tool arguments/results (F5 reuses it). */
export function JsonTree({ value, copy }: { value: unknown; copy: Copy }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [raw, setRaw] = useState(false);
  const view = jsonView(value, expanded);
  const toggle = (path: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  if (raw) return <div className="tool-json" data-json-raw="true">
    <div className="tool-json-bar"><button type="button" className="tool-card-action" onClick={() => setRaw(false)}>{copy('Tree', '树形')}</button></div>
    <pre className="tool-json-raw">{JSON.stringify(value, null, 2)}</pre>
  </div>;
  return <div className="tool-json" data-json-nodes={view.nodes}>
    <div className="tool-json-bar">
      <button type="button" className="tool-card-action" onClick={() => setRaw(true)}>{copy('Raw', '原始')}</button>
    </div>
    <div className="tool-json-tree" role="tree">
      {view.rows.map(row => <div className="tool-json-row" key={row.path} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.expandable ? row.expanded : undefined} style={{ paddingLeft: row.depth * 14 }}>
        {row.expandable
          ? <button type="button" className="tool-json-toggle" onClick={() => toggle(row.path)} aria-label={row.expanded ? copy('Collapse', '收起') : copy('Expand', '展开')}><Icon name="chevR" /></button>
          : <span className="tool-json-spacer" aria-hidden="true" />}
        {row.key !== undefined && <span className="tool-json-key">{row.key}:</span>}
        <span className={`tool-json-value is-${row.kind}`}>{row.preview}</span>
      </div>)}
    </div>
    {view.truncated && <button type="button" className="tool-card-action" onClick={() => setRaw(true)}>{copy('Show raw', '显示原始文本')}</button>}
  </div>;
}
