/**
 * useNotificationHighlight — 卡片端的通知定位反馈。
 *
 * 订阅 store 的 `highlightCardId`（按卡片 id 精确选择，避免无关重渲染）。
 * 命中时把卡片根元素滚动到可视区域中央，并返回 `highlighted` 供根元素
 * 挂 `notification-locate-pulse` 脉冲类（reduce-motion 时 CSS 侧退化为
 * 静态描边，滚动也改为瞬时）。
 */
import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useTerminalStore } from '../../stores/terminalStore';

export function useNotificationHighlight<T extends HTMLElement>(cardId: string) {
  const highlighted = useTerminalStore((s) => s.highlightCardId === cardId);
  const reduceMotion = useReducedMotion();
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!highlighted) return;
    const el = ref.current;
    // jsdom has no scrollIntoView — feature-guard keeps tests honest.
    if (!el || typeof el.scrollIntoView !== 'function') return;
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }, [highlighted, reduceMotion]);

  return { highlighted, ref };
}
