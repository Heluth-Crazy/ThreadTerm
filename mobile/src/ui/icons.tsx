import React from 'react';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';
import type { Theme } from './theme';

export type IconName = 'bell' | 'folder' | 'chat' | 'settings' | 'computer' | 'chevron' | 'plus' | 'arrowLeft' | 'send' | 'terminal' | 'file' | 'git' | 'more' | 'search' | 'lock' | 'link' | 'refresh' | 'stop' | 'warning' | 'check' | 'copy' | 'paperclip' | 'close' | 'eye' | 'key' | 'camera';

export function Icon({ name, color, size = 22 }: { name: IconName; color: string; size?: number }) {
  const p = { stroke: color, strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  const common = { width: size, height: size, viewBox: '0 0 24 24', accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
  switch (name) {
    case 'bell': return <Svg {...common}><Path {...p} d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 22h4" /></Svg>;
    case 'folder': return <Svg {...common}><Path {...p} d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>;
    case 'chat': return <Svg {...common}><Path {...p} d="M21 11.5a8 8 0 0 1-8.4 8l-5.6 2 1.4-4.1A8 8 0 1 1 21 11.5z" /></Svg>;
    case 'settings': return <Svg {...common}><Circle {...p} cx="12" cy="12" r="3" /><Path {...p} d="m19.4 15 .8 1.4-2.3 2.3-1.4-.8a7 7 0 0 1-2 .8L14 20h-4l-.5-1.3a7 7 0 0 1-2-.8l-1.4.8-2.3-2.3.8-1.4a7 7 0 0 1-.8-2L2.5 12l1.3-2.2a7 7 0 0 1 .8-2L3.8 6.4l2.3-2.3 1.4.8a7 7 0 0 1 2-.8L10 2.8h4l.5 1.3a7 7 0 0 1 2 .8l1.4-.8 2.3 2.3-.8 1.4a7 7 0 0 1 .8 2l1.3.5v4l-1.3.5a7 7 0 0 1-.8 2z" /></Svg>;
    case 'computer': return <Svg {...common}><Rect {...p} x="3" y="4" width="18" height="12" rx="2" /><Path {...p} d="M8 20h8M12 16v4" /></Svg>;
    case 'chevron': return <Svg {...common}><Polyline {...p} points="9,5 16,12 9,19" /></Svg>;
    case 'plus': return <Svg {...common}><Line {...p} x1="12" y1="5" x2="12" y2="19" /><Line {...p} x1="5" y1="12" x2="19" y2="12" /></Svg>;
    case 'arrowLeft': return <Svg {...common}><Path {...p} d="m14 5-7 7 7 7M7 12h14" /></Svg>;
    case 'send': return <Svg {...common}><Path {...p} d="m21 3-8.5 18-2.2-7.3L3 11.5zM10.3 13.7 21 3" /></Svg>;
    case 'terminal': return <Svg {...common}><Path {...p} d="m5 7 4 4-4 4M12 16h7" /></Svg>;
    case 'file': return <Svg {...common}><Path {...p} d="M6 3h8l4 4v14H6zM14 3v5h4" /></Svg>;
    case 'git': return <Svg {...common}><Circle {...p} cx="7" cy="6" r="2" /><Circle {...p} cx="17" cy="18" r="2" /><Circle {...p} cx="17" cy="6" r="2" /><Path {...p} d="M9 6h8M7 8v8a2 2 0 0 0 2 2h6" /></Svg>;
    case 'more': return <Svg {...common}><Circle fill={color} cx="5" cy="12" r="1.5" /><Circle fill={color} cx="12" cy="12" r="1.5" /><Circle fill={color} cx="19" cy="12" r="1.5" /></Svg>;
    case 'search': return <Svg {...common}><Circle {...p} cx="10.5" cy="10.5" r="6" /><Line {...p} x1="15" y1="15" x2="21" y2="21" /></Svg>;
    case 'lock': return <Svg {...common}><Rect {...p} x="5" y="10" width="14" height="11" rx="2" /><Path {...p} d="M8 10V7a4 4 0 0 1 8 0v3" /></Svg>;
    case 'link': return <Svg {...common}><Path {...p} d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></Svg>;
    case 'refresh': return <Svg {...common}><Path {...p} d="M20 11a8 8 0 1 0 1 4M20 5v6h-6" /></Svg>;
    case 'stop': return <Svg {...common}><Rect {...p} x="6" y="6" width="12" height="12" rx="2" /></Svg>;
    case 'warning': return <Svg {...common}><Path {...p} d="M12 3 2.9 20h18.2zM12 9v4M12 17h.01" /></Svg>;
    case 'check': return <Svg {...common}><Path {...p} d="m5 12 4 4L19 6" /></Svg>;
    case 'copy': return <Svg {...common}><Rect {...p} x="8" y="8" width="12" height="12" rx="2" /><Path {...p} d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Svg>;
    case 'paperclip': return <Svg {...common}><Path {...p} d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 1 1 5.7 5.6L9 17.3a2 2 0 0 1-2.8-2.8l8.1-8.1" /></Svg>;
    case 'close': return <Svg {...common}><Line {...p} x1="6" y1="6" x2="18" y2="18" /><Line {...p} x1="18" y1="6" x2="6" y2="18" /></Svg>;
    case 'eye': return <Svg {...common}><Path {...p} d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" /><Circle {...p} cx="12" cy="12" r="2.5" /></Svg>;
    case 'key': return <Svg {...common}><Circle {...p} cx="8" cy="15" r="4" /><Path {...p} d="m11 12 9-9M15 7l2 2M17 5l2 2" /></Svg>;
    case 'camera': return <Svg {...common}><Path {...p} d="M4 7h4l1.5-2h5L16 7h4v12H4z" /><Circle {...p} cx="12" cy="13" r="3.5" /></Svg>;
  }
}

export function statusColor(theme: Theme, state: string | undefined) {
  if (state === 'connected' || state === 'running' || state === 'idle') return theme.green;
  if (state === 'waiting' || state === 'connecting' || state === 'awaiting_approval' || state === 'awaiting_input') return theme.amber;
  if (state === 'error' || state === 'interrupted' || state === 'disconnected' || state === 'revoked' || state === 'pin-mismatch' || state === 'incompatible') return theme.red;
  return theme.faint;
}
