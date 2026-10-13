import { useMemo, useState } from 'react';
import { parseGeneratedUi, type UiComponent } from '../../generatedUi';
import type { BlockProps } from './index';
import './generated-ui.css';
const palette = ['var(--primary)', 'var(--amber)', 'var(--muted)', 'var(--danger)'];
function Chart({ chart, copy }: { chart: Extract<UiComponent, { type: 'chart' }>; copy: BlockProps['copy'] }) {
  const max = Math.max(1, ...chart.data.map(point => point.value)), total = chart.data.reduce((sum, point) => sum + point.value, 0), count = Math.max(1, chart.data.length);
  let angle = -Math.PI / 2;
  return <figure className="generated-chart"><svg viewBox="0 0 600 260" role="img" aria-label={chart.title ?? copy(`${chart.kind} chart`, `${chart.kind === 'bar' ? '柱状' : chart.kind === 'line' ? '折线' : '饼'}图`)}>
    <title>{chart.title ?? copy('Chart', '图表')}</title><desc>{chart.data.map(point => `${point.label}: ${point.value}`).join('; ')}</desc>
    {chart.kind === 'bar' && chart.data.map((point, index) => <rect key={index} x={24 + index * 552 / count} y={224 - point.value / max * 200} width={Math.max(1, 552 / count - 4)} height={point.value / max * 200} fill={palette[index % palette.length]} />)}
    {chart.kind === 'line' && <><polyline fill="none" stroke="var(--primary)" strokeWidth="3" points={chart.data.map((point, index) => `${24 + index * 552 / Math.max(1, count - 1)},${224 - point.value / max * 200}`).join(' ')} />{chart.data.map((point, index) => <circle key={index} cx={24 + index * 552 / Math.max(1, count - 1)} cy={224 - point.value / max * 200} r="4" fill="var(--primary)" />)}</>}
    {chart.kind === 'pie' && total > 0 && chart.data.map((point, index) => {
      if (!point.value) return null;
      const start = angle, sweep = point.value / total * Math.PI * 2; angle += sweep;
      if (sweep >= Math.PI * 2 - 1e-9) return <circle key={index} cx="300" cy="130" r="112" fill={palette[index % palette.length]} />;
      return <path key={index} fill={palette[index % palette.length]} d={`M300 130 L${300 + Math.cos(start) * 112} ${130 + Math.sin(start) * 112} A112 112 0 ${sweep > Math.PI ? 1 : 0} 1 ${300 + Math.cos(angle) * 112} ${130 + Math.sin(angle) * 112} Z`} />;
    })}
    {!chart.data.length || total === 0 ? <text x="300" y="130" textAnchor="middle" fill="var(--muted)">{copy('No data', '暂无数据')}</text> : null}
  </svg><figcaption>{chart.title}</figcaption><ul className="generated-chart-legend">{chart.data.map((point, index) => <li key={index}><span aria-hidden="true" style={{ background: palette[index % palette.length] }} />{point.label}: {point.value}</li>)}</ul></figure>;
}
function Component({ item, copy }: { item: UiComponent; copy: BlockProps['copy'] }) {
  switch (item.type) {
    case 'card': return <section className="generated-card">{item.title && <h3>{item.title}</h3>}{item.children?.map((child, index) => <Component item={child} copy={copy} key={index} />)}</section>;
    case 'stat': return <dl className="generated-stat"><dt>{item.label}</dt><dd>{item.value}</dd></dl>;
    case 'table': return <div className="generated-table"><table><thead><tr>{item.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{item.rows.map((row, index) => <tr key={index}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody></table></div>;
    case 'list': return <ul className="generated-list">{item.items.map((text, index) => <li key={index}>{text}</li>)}</ul>;
    case 'badge': return <span className={`chip generated-badge is-${item.tone ?? 'neutral'}`} title={item.text}>{item.text}</span>;
    case 'progress': return <div className="generated-progress"><span>{item.label} {Math.round(item.value / (item.max ?? 100) * 100)}%</span><div role="progressbar" aria-label={item.label ?? copy('Progress', '进度')} aria-valuenow={item.value} aria-valuemin={0} aria-valuemax={item.max ?? 100}><i style={{ width: `${item.value / (item.max ?? 100) * 100}%` }} /></div></div>;
    case 'chart': return <Chart chart={item} copy={copy} />;
  }
}
export default function GeneratedUi({ source, copy, onInsert }: BlockProps) {
  const parsed = useMemo(() => parseGeneratedUi(source), [source]), [issue, setIssue] = useState('');
  if (!parsed.spec) return <div className="markdown-extra generated-ui" data-testid="generated-ui"><p className="markdown-extra-error" role="alert">{copy('Invalid generated UI', '生成式界面格式无效')}: {parsed.error}</p><pre>{source}</pre></div>;
  return <div className="generated-ui" data-testid="generated-ui">{parsed.spec.components.map((item, index) => <Component item={item} copy={copy} key={index} />)}
    {!!parsed.spec.buttons?.length && <div className="generated-ui-actions">{parsed.spec.buttons.map((button, index) => <button type="button" className="btn btn-sm" key={index} title={button.label} aria-label={button.label} disabled={!onInsert} onClick={() => { try { onInsert?.(button.text); setIssue(''); } catch (error) { setIssue(String(error)); } }}><span className="generated-ui-action-label">{button.label}</span></button>)}</div>}
    {issue && <p className="markdown-extra-error" role="alert">{issue}</p>}
  </div>;
}
