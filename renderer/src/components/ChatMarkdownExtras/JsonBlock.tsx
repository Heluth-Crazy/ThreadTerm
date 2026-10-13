import { useMemo } from 'react';
import { JsonTree } from '../JsonTree';
import type { BlockProps } from './index';
export default function JsonBlock({ source, copy }: BlockProps) {
  const parsed = useMemo(() => { try { return { value: JSON.parse(source) as unknown }; } catch (error) { return { error: String(error) }; } }, [source]);
  return <div className="markdown-extra json-extra" data-testid="markdown-json">{parsed.error ? <><p className="markdown-extra-error" role="alert">{copy('Invalid JSON', 'JSON 格式无效')}: {parsed.error}</p><pre>{source}</pre></> : <JsonTree value={parsed.value} copy={copy} />}</div>;
}
