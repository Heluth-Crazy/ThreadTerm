/**
 * ExpandFromCornerShell — full-screen backdrop that enters with a circular
 * clip-path reveal from an origin point (default: top-right, close to where
 * the macOS menubar icon or Cmd+Shift+Space cursor focus tends to land).
 *
 * The component owns only visual chrome:
 *   • dim glass backdrop
 *   • radial reveal animation on mount / unmount
 *   • `children` render into the centred content area
 *
 * It is window-agnostic: used by the selector webview OR inline inside
 * the main window when the user selects "inline" surface.
 */
import { type ReactNode, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export interface ExpandFromCornerShellProps {
  visible: boolean;
  /** Origin for the clip reveal, in CSS units. Defaults to top-right. */
  origin?: { x: string; y: string };
  /** Click on the backdrop (outside the content). */
  onBackdropClick?: () => void;
  children?: ReactNode;
}

export function ExpandFromCornerShell({
  visible,
  origin = { x: '95%', y: '5%' },
  onBackdropClick,
  children,
}: ExpandFromCornerShellProps) {
  const clipOrigin = useMemo(() => `${origin.x} ${origin.y}`, [origin.x, origin.y]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="selector-shell"
          initial={{ clipPath: `circle(0% at ${clipOrigin})`, opacity: 0.8 }}
          animate={{ clipPath: `circle(150% at ${clipOrigin})`, opacity: 1 }}
          exit={{ clipPath: `circle(0% at ${clipOrigin})`, opacity: 0 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          onClick={onBackdropClick}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-xl"
        >
          {/* Inner content — stop propagation so clicks on cards don't close. */}
          <div
            className="relative flex h-full w-full items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
