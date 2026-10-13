import { useMemo } from 'react';
import katex from 'katex';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import type { BlockProps } from './index';
export default function MathBlock({ source, display, copy }: BlockProps) {
  const rendered = useMemo(() => {
    try { return { html: DOMPurify.sanitize(katex.renderToString(source, { displayMode: display, throwOnError: true, trust: false, strict: 'error', maxExpand: 1000, maxSize: 20 })) }; }
    catch (error) { return { error: String(error) }; }
  }, [source, display]);
  return rendered.error ? <span className="markdown-extra-error" role="alert" title={rendered.error}>{copy('Math error', '公式错误')}: {source}</span> : <span className={display ? 'markdown-math is-display' : 'markdown-math'} data-testid="markdown-math" dangerouslySetInnerHTML={{ __html: rendered.html! }} />;
}
