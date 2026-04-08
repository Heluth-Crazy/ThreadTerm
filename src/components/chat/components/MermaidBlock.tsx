import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { sanitizeSvg } from '../../../utils/sanitize';

mermaid.initialize({ startOnLoad: false, theme: 'dark' });

interface MermaidBlockProps {
  code: string;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const id = `mermaid-${Math.random().toString(36).slice(2)}`;
    mermaid
      .render(id, code)
      .then(({ svg }) => {
        if (ref.current) {
          ref.current.innerHTML = sanitizeSvg(svg);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [code]);

  if (error) {
    return <pre className="text-red-400 text-xs">{error}</pre>;
  }
  return <div ref={ref} className="mermaid-container my-2" />;
}
