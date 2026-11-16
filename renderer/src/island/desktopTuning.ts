import type { IslandMetricsOverrides, IslandMotionOverrides } from './engine';

/* islandcn is tuned to a phone. A PC has no camera in the middle of the screen: the gap kept for it shrinks to 40 px,
   the island hangs 8 px from the top edge, the compact pill may carry a session name, and the list opens taller with
   a desktop panel's corner (the phone's 47.9 clipped the top-right text). Nor is the camera housing drawn: on a
   phone it sits above the content and hides whatever passes under it, which cut the top off a long expanded title
   ("needs approval" read "neeas"). A click expands (no long-press on a desktop), so the long-press timers are pushed
   out of reach. Values from the approved prototype. */
export const ISLAND_STAGE_WIDTH = 440;
export const desktopMetrics: IslandMetricsOverrides = {
  screen: { width: ISLAND_STAGE_WIDTH },
  top: 8,
  idle: { width: 40, height: 30 },
  compact: { sensorWidth: 40, maxSlotWidth: 168, maxWidth: 360, balance: 0 },
  split: { detached: { width: 0 }, maxSpan: 400 },
  expanded: { top: 8, maxHeight: 340, radius: 30 },
  contentClip: { radius: 30 },
  sensor: { opacity: 0 },
};
export const desktopMotion: IslandMotionOverrides = { longPress: 1e6, longPressBubble: 1e6, press: { decide: 1e6 }, alertHold: 5.5 };
/** Snap back to the centre when a drag ends this close to it (main applies the same rule). */
export const SNAP_PX = 28;
