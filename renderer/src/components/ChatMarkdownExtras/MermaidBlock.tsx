import { useEffect, useId, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { SurfaceDialog } from '../SurfaceDialog';
import { safeMermaidSvg } from './mermaidSafety';
import { diagramDimensions, diagramRasterSize } from '../../diagramGeometry';
import type { BlockProps } from './index';

let renderQueue: Promise<unknown> = Promise.resolve();
export default function MermaidBlock({ source, copy }: BlockProps) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, ''), root = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState(''), [issue, setIssue] = useState(''), [raw, setRaw] = useState(false), [zoom, setZoom] = useState<number>(), [fullscreen, setFullscreen] = useState(false), [downloading, setDownloading] = useState(false);
  const dimensions = useMemo(() => diagramDimensions(svg), [svg]);
  useEffect(() => {
    let current = true; setSvg(''); setIssue('');
    const render = async () => {
      if (!current) return;
      try {
        if (source.length > 64 * 1024) throw new Error(copy('Diagram exceeds 64 KiB.', '图表不能超过 64 KiB。'));
        const theme = getComputedStyle(root.current ?? document.documentElement);
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'base', fontFamily: theme.fontFamily, flowchart: { htmlLabels: false }, themeVariables: { primaryColor: theme.getPropertyValue('--soft').trim(), primaryTextColor: theme.getPropertyValue('--text').trim(), primaryBorderColor: theme.getPropertyValue('--border').trim(), lineColor: theme.getPropertyValue('--muted').trim(), background: theme.getPropertyValue('--surface').trim() } });
        const result = await mermaid.render(`ttmermaid${id}`, source);
        if (current) setSvg(safeMermaidSvg(result.svg));
      } catch (error) { if (current) setIssue(String(error)); }
    };
    renderQueue = renderQueue.then(render, render);
    return () => { current = false; };
  }, [source, id]);
  const download = async (format: 'svg' | 'png' | 'mmd') => {
    if (downloading) return; setDownloading(true); setIssue('');
    try {
      let blob = new Blob([format === 'mmd' ? source : svg], { type: format === 'mmd' ? 'text/plain;charset=utf-8' : 'image/svg+xml' });
      if (format === 'png') {
        const url = URL.createObjectURL(blob);
        try {
          const image = new Image(); image.src = url; await image.decode();
          const canvas = document.createElement('canvas'), size = diagramRasterSize(dimensions); canvas.width = size.width; canvas.height = size.height;
          canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
          blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG export failed')), 'image/png'));
        } finally { URL.revokeObjectURL(url); }
      }
      const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `diagram.${format}`; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) { setIssue(String(error)); }
    finally { setDownloading(false); }
  };
  const diagram = <div className={`mermaid-canvas${zoom === undefined ? ' is-fit' : ''}`} style={{ '--diagram-width': zoom === undefined ? undefined : `${dimensions.width * zoom}px` } as React.CSSProperties} dangerouslySetInnerHTML={{ __html: svg }} />;
  return <div ref={root} className="markdown-extra mermaid-extra" data-testid="markdown-mermaid">
    <div className="markdown-extra-toolbar">
      <button type="button" className="btn btn-sm" aria-pressed={raw} onClick={() => setRaw(value => !value)}>{raw ? copy('Diagram', '图表') : copy('Show source', '显示源码')}</button>
      <button type="button" className="btn btn-sm" disabled={!svg} aria-pressed={zoom === undefined} onClick={() => setZoom(undefined)}>{copy('Fit', '适应')}</button>
      <button type="button" className="btn btn-sm" disabled={!svg} aria-pressed={zoom === 1} onClick={() => setZoom(1)}>100 %</button>
      <button type="button" className="btn btn-sm" disabled={!svg || (zoom ?? 1) <= .25} aria-label={copy('Zoom out', '缩小')} onClick={() => setZoom(value => Math.max(.25, (value ?? 1) - .25))}>−</button>
      <button type="button" className="btn btn-sm" disabled={!svg || (zoom ?? 1) >= 4} aria-label={copy('Zoom in', '放大')} onClick={() => setZoom(value => Math.min(4, (value ?? 1) + .25))}>+</button>
      <button type="button" className="btn btn-sm" disabled={!svg} onClick={() => setFullscreen(true)}>{copy('Fullscreen', '全屏')}</button>
      {(['svg', 'png', 'mmd'] as const).map(format => <button type="button" className="btn btn-sm" disabled={downloading || (format !== 'mmd' && !svg)} key={format} onClick={() => void download(format)} aria-label={copy(`Download ${format.toUpperCase()}`, `下载 ${format.toUpperCase()}`)}>{format.toUpperCase()}</button>)}
    </div>
    {issue && <p className="markdown-extra-error" role="alert">{copy('Diagram error', '图表错误')}: {issue}</p>}
    {raw || issue ? <pre>{source}</pre> : svg ? diagram : <p role="status">{copy('Rendering diagram…', '正在绘制图表…')}</p>}
    {fullscreen && <SurfaceDialog title={copy('Diagram', '图表')} onClose={() => setFullscreen(false)} size="wide">{diagram}</SurfaceDialog>}
  </div>;
}
