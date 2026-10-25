import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { chartTipPosition, type TipBounds } from '../usagePresentation';

/** Details remain within chart data so adjacent controls always stay reachable. */
export function UsageTooltip({ x, y, bounds, className, children }: {
  x: number; y: number; bounds: TipBounds; className: string; children: ReactNode;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: bounds.left, top: bounds.top });
  useLayoutEffect(() => {
    if (!node.current) return;
    setPosition(chartTipPosition(x, y, node.current.offsetWidth, node.current.offsetHeight, bounds));
  }, [x, y, bounds, children]);
  return <div ref={node} className={`usage-tip ${className}`} role="tooltip"
    style={{ ...position, width: Math.min(480, bounds.width) }}>{children}</div>;
}
