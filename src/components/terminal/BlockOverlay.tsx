/**
 * BlockOverlay — renders block boundary markers and action toolbars on top of
 * the xterm Shell area.
 *
 * Strategy (Stage 4):
 *   1. For each block, register an xterm IMarker pinned to `bufferStart`
 *      so the row position survives scrollback growth.
 *   2. On every render *and* on every xterm scroll/resize, re-derive
 *      pixel coordinates: top = (marker.line - viewportY) * cellHeight.
 *   3. The hover-zone div uses the derived pixel offsets directly, so the
 *      toolbar appears anchored to the correct row.
 *   4. The collapsed-output cover spans (bufferEnd - bufferStart) rows.
 *   5. Decoration API is also used to render an overview-ruler dot in the
 *      xterm minimap-equivalent for visual scanning.
 *
 * All rendering is a no-op when `blocks` is empty (shell integration not
 * installed / opt-in not enabled).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Block } from '../../types/terminal';
import { getTerminal } from './xtermRegistry';
import { BlockToolbar } from './BlockToolbar';
import { useTerminalStore } from '../../stores/terminalStore';
import { pty } from '../../lib/tauri-bridge';
import type { IDecoration, IMarker } from '@xterm/xterm';

export interface BlockOverlayProps {
  cardId: string;
  ptyId: string;
  blocks: Block[];
  /** When false, hovering a block header does not mutate the store. */
  inspectorOpen: boolean;
}

interface BlockGeometry {
  blockId: string;
  /** Pixel offset from the top of the xterm host container. */
  top: number;
  /** Pixel height covering bufferStart..bufferEnd inclusive. */
  height: number;
  /** Whether the header row is currently inside the visible viewport. */
  visible: boolean;
}

/** Read xterm's per-row pixel height by sampling a rendered row, with a
 *  conservative fallback (xterm default = 17px). */
function getCellHeight(rootEl: HTMLElement | undefined): number {
  if (!rootEl) return 17;
  const row = rootEl.querySelector('.xterm-rows > div');
  if (row instanceof HTMLElement && row.offsetHeight > 0) return row.offsetHeight;
  return 17;
}

const RERUN_CONFIRM_MS = 1500;
/** Pixel height of the hover-zone div (Tailwind `h-5`). The collapsed-output
 *  cover starts immediately below the hover zone, so this constant must
 *  stay in sync with the className `h-5`. */
const HOVER_ZONE_PX = 20;

export function BlockOverlay({ cardId, ptyId, blocks, inspectorOpen }: BlockOverlayProps) {
  const { t } = useTranslation('terminal');
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const [geometries, setGeometries] = useState<BlockGeometry[]>([]);
  const [pendingRerun, setPendingRerun] = useState<string | null>(null);
  const decorationsRef = useRef<Map<string, IDecoration[]>>(new Map());
  const markersRef = useRef<Map<string, IMarker>>(new Map());
  const rerunTimerRef = useRef<number | null>(null);

  const collapsedBlockIds = useTerminalStore((s) => s.collapsedBlockIds);
  const toggleBlockCollapsed = useTerminalStore((s) => s.toggleBlockCollapsed);
  const selectBlock = useTerminalStore((s) => s.selectBlock);
  const bookmarks = useTerminalStore((s) => s.bookmarks);
  const addBookmark = useTerminalStore((s) => s.addBookmark);
  const removeBookmark = useTerminalStore((s) => s.removeBookmark);

  // ── decoration & marker management ────────────────────────────────────────

  useEffect(() => {
    // Always clean up previous decorations and markers, even if we're about
    // to bail out — otherwise blocks-cleared / ptyId-changed leaks them.
    const disposeAll = () => {
      decorationsRef.current.forEach((decs) => decs.forEach((d) => d.dispose()));
      decorationsRef.current.clear();
      markersRef.current.forEach((m) => m.dispose());
      markersRef.current.clear();
    };
    disposeAll();

    const term = getTerminal(ptyId);
    if (!term || blocks.length === 0) {
      setGeometries([]);
      return;
    }

    for (const block of blocks) {
      const cursorAbsolute =
        term.buffer.active.baseY + term.buffer.active.cursorY;
      const targetOffset = block.bufferStart - cursorAbsolute;

      let marker: IMarker | undefined;
      try {
        marker = term.registerMarker(targetOffset) ?? undefined;
      } catch {
        continue;
      }
      if (!marker) continue;

      markersRef.current.set(block.id, marker);

      // When a marker is evicted from scrollback (line === -1), clean up.
      marker.onDispose(() => {
        markersRef.current.delete(block.id);
        decorationsRef.current.delete(block.id);
      });

      try {
        const dec = term.registerDecoration({
          marker,
          width: 1,
          overviewRulerOptions:
            block.state === 'failed'
              ? { color: '#ef4444', position: 'full' }
              : block.state === 'running'
                ? { color: '#f59e0b', position: 'full' }
                : { color: '#6b7280', position: 'full' },
        });

        if (dec) {
          dec.onRender((el) => {
            el.style.cssText =
              'border-top: 1px solid rgba(100,100,120,0.35); pointer-events: none;';
            if (block.state === 'failed') {
              el.style.borderLeft = '2px solid #ef4444';
            }
          });
          const existing = decorationsRef.current.get(block.id) ?? [];
          decorationsRef.current.set(block.id, [...existing, dec]);
        }
      } catch {
        // Decoration API unavailable — visual indicator is gracefully missing.
      }
    }

    // ── pixel-position recomputation ───────────────────────────────────────
    let rafId = 0;
    const recompute = () => {
      rafId = 0;
      const liveTerm = getTerminal(ptyId);
      if (!liveTerm) return;

      const cellHeight = getCellHeight(liveTerm.element ?? undefined);
      const viewportY = liveTerm.buffer.active.viewportY;

      const next: BlockGeometry[] = blocks.map((block) => {
        const m = markersRef.current.get(block.id);
        if (!m || m.isDisposed) {
          return { blockId: block.id, top: -9999, height: 0, visible: false };
        }
        const startLine = m.line;
        const endLine = block.bufferEnd ?? startLine;
        const top = (startLine - viewportY) * cellHeight;
        const rowSpan = Math.max(1, endLine - startLine + 1);
        const height = rowSpan * cellHeight;
        const visible = startLine >= viewportY && startLine < viewportY + liveTerm.rows;
        return { blockId: block.id, top, height, visible };
      });
      setGeometries(next);
    };

    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(recompute);
    };
    schedule();

    const scrollSub = term.onScroll(schedule);
    const resizeSub = term.onResize(schedule);

    let resizeObs: ResizeObserver | null = null;
    if (term.element && typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(schedule);
      resizeObs.observe(term.element);
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      scrollSub.dispose();
      resizeSub.dispose();
      if (resizeObs) resizeObs.disconnect();
      disposeAll();
    };
  }, [ptyId, blocks]);

  // ── toolbar callbacks ─────────────────────────────────────────────────────

  const handleCopyCommand = useCallback(async (block: Block) => {
    try {
      await navigator.clipboard.writeText(block.command);
    } catch {
      // Clipboard unavailable (insecure context / Linux without xclip).
      // A future iteration will surface a toast; for now fail silently
      // rather than throwing.
    }
  }, []);

  const extractBlockOutput = useCallback(
    (block: Block): string => {
      const term = getTerminal(ptyId);
      if (!term) return '';
      const buf = term.buffer.active;
      const start = block.bufferStart + 1;
      const end = block.bufferEnd ?? buf.baseY + term.rows;
      const lines: string[] = [];
      for (let row = start; row <= end; row++) {
        const line = buf.getLine(row);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join('\n');
    },
    [ptyId],
  );

  const handleCopyOutput = useCallback(
    async (block: Block) => {
      try {
        await navigator.clipboard.writeText(extractBlockOutput(block));
      } catch {
        /* see handleCopyCommand */
      }
    },
    [extractBlockOutput],
  );

  const handleCopyBoth = useCallback(
    async (block: Block) => {
      try {
        const combined = `$ ${block.command}\n${extractBlockOutput(block)}`;
        await navigator.clipboard.writeText(combined);
      } catch {
        /* see handleCopyCommand */
      }
    },
    [extractBlockOutput],
  );

  const handleRerun = useCallback(
    (block: Block) => {
      // Two-step confirmation: first click arms, second click within
      // RERUN_CONFIRM_MS executes. Auto-cancels otherwise.
      if (pendingRerun === block.id) {
        pty.input(ptyId, `${block.command}\r`).catch(() => undefined);
        setPendingRerun(null);
        if (rerunTimerRef.current) {
          window.clearTimeout(rerunTimerRef.current);
          rerunTimerRef.current = null;
        }
        return;
      }
      setPendingRerun(block.id);
      if (rerunTimerRef.current) window.clearTimeout(rerunTimerRef.current);
      rerunTimerRef.current = window.setTimeout(() => {
        setPendingRerun((cur) => (cur === block.id ? null : cur));
        rerunTimerRef.current = null;
      }, RERUN_CONFIRM_MS);
    },
    [pendingRerun, ptyId],
  );

  // Cancel pending re-run when the component unmounts
  useEffect(() => {
    return () => {
      if (rerunTimerRef.current) {
        window.clearTimeout(rerunTimerRef.current);
        rerunTimerRef.current = null;
      }
    };
  }, []);

  const handleExplain = useCallback(
    (block: Block) => {
      // Stage 6 placeholder — selecting the block lets the inspector show it.
      selectBlock(cardId, block.id);
    },
    [cardId, selectBlock],
  );

  // Geometry lookup map for O(1) per-block reads in the render
  const geometryById = useMemo(() => {
    const m = new Map<string, BlockGeometry>();
    for (const g of geometries) m.set(g.blockId, g);
    return m;
  }, [geometries]);

  const collapsedSet = useMemo(() => new Set(collapsedBlockIds), [collapsedBlockIds]);

  /** blockId → Bookmark for O(1) per-block lookup in render. */
  const bookmarkByBlockId = useMemo(() => {
    const m = new Map<string, (typeof bookmarks)[number]>();
    for (const b of bookmarks) m.set(b.blockId, b);
    return m;
  }, [bookmarks]);

  if (blocks.length === 0) return null;

  return (
    <>
      {blocks.map((block) => {
        const geom = geometryById.get(block.id);
        if (!geom || !geom.visible) return null;

        const isHovered = hoveredBlockId === block.id;
        const isCollapsed = collapsedSet.has(block.id);
        const isPendingRerun = pendingRerun === block.id;

        return (
          <div key={block.id}>
            {/* Hover zone — anchored to the block's start row */}
            <div
              data-block-id={block.id}
              data-block-state={block.state}
              className="pointer-events-auto absolute left-0 right-0 flex h-5 cursor-default items-center px-1"
              style={{ top: `${geom.top}px` }}
              onMouseEnter={() => {
                setHoveredBlockId(block.id);
                // Only mutate selection when the inspector is open — avoids
                // pointless store churn during normal terminal use.
                if (inspectorOpen) selectBlock(cardId, block.id);
              }}
              onMouseLeave={() => setHoveredBlockId(null)}
              onClick={(e) => {
                e.stopPropagation();
                selectBlock(cardId, block.id);
              }}
            >
              <span className="mr-auto truncate font-mono text-[10px] text-muted-foreground/70 select-none">
                $ {block.command}
              </span>

              {block.state === 'running' && (
                <span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              )}
              {block.state === 'failed' && (
                <span className="mr-1 h-1.5 w-1.5 rounded-full bg-red-500" />
              )}

              {isHovered && (() => {
                const bookmark = bookmarkByBlockId.get(block.id);
                return (
                  <div className="pointer-events-auto absolute right-1 top-0 z-50">
                    <BlockToolbar
                      block={block}
                      collapsed={isCollapsed}
                      rerunPending={isPendingRerun}
                      bookmarked={!!bookmark}
                      onToggleBookmark={() => {
                        if (bookmark) removeBookmark(bookmark.id);
                        else
                          addBookmark({
                            blockId: block.id,
                            cardId,
                            command: block.command,
                            cwd: block.cwd,
                          });
                      }}
                      onCopyCommand={() => void handleCopyCommand(block)}
                      onCopyOutput={() => void handleCopyOutput(block)}
                      onCopyBoth={() => void handleCopyBoth(block)}
                      onRerun={() => handleRerun(block)}
                      onToggleCollapse={() => toggleBlockCollapsed(block.id)}
                      onExplain={() => handleExplain(block)}
                    />
                  </div>
                );
              })()}
            </div>

            {/* Collapsed-output cover */}
            {isCollapsed && (
              <div
                className="pointer-events-auto absolute left-0 right-0 flex cursor-pointer items-center justify-center bg-background/90 text-[10px] text-muted-foreground"
                style={{
                  top: `${geom.top + HOVER_ZONE_PX}px`,
                  height: `${Math.max(0, geom.height - HOVER_ZONE_PX)}px`,
                }}
                title={t('block.expand', { defaultValue: 'Expand block' })}
                onClick={() => toggleBlockCollapsed(block.id)}
              >
                {block.command} — {t('block.collapsed', { defaultValue: 'collapsed' })}
                {block.exitCode !== undefined && block.exitCode !== null && (
                  <span
                    className={
                      block.exitCode === 0 ? 'ml-2 text-green-500' : 'ml-2 text-red-500'
                    }
                  >
                    exit {block.exitCode}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
