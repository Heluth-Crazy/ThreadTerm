const SYNCHRONIZED_FRAME_START = '\x1b[?2026h';
const SYNCHRONIZED_FRAME_END = '\x1b[?2026l';
const FRAME_MARKERS = [
  SYNCHRONIZED_FRAME_START,
  SYNCHRONIZED_FRAME_END,
] as const;

interface FrameObservation {
  wasOpen: boolean;
  opened: boolean;
  closed: boolean;
  isOpen: boolean;
}

/**
 * DEC 2026 synchronized updates are an atomic visual transaction. xterm must
 * still receive every byte, but an explicit `refresh()` while the transaction
 * is open defeats that atomicity and exposes intermediate prompt layouts.
 */
export function createSynchronizedFrameRefreshGate() {
  let frameOpen = false;
  let markerCarry = '';
  let pendingRefresh = false;

  const observe = (data: string): FrameObservation => {
    const wasOpen = frameOpen;
    const combined = `${markerCarry}${data}`;
    let opened = false;
    let closed = false;
    let offset = 0;

    while (offset < combined.length) {
      const startAt = combined.indexOf(SYNCHRONIZED_FRAME_START, offset);
      const endAt = combined.indexOf(SYNCHRONIZED_FRAME_END, offset);
      if (startAt < 0 && endAt < 0) break;

      if (startAt >= 0 && (endAt < 0 || startAt < endAt)) {
        frameOpen = true;
        opened = true;
        offset = startAt + SYNCHRONIZED_FRAME_START.length;
      } else {
        frameOpen = false;
        closed = true;
        offset = endAt + SYNCHRONIZED_FRAME_END.length;
      }
    }

    markerCarry = longestMarkerPrefixSuffix(combined);
    return { wasOpen, opened, closed, isOpen: frameOpen };
  };

  return {
    shouldRefreshAfterWrite(data: string, wantsRefresh: boolean): boolean {
      const frame = observe(data);
      if (
        wantsRefresh &&
        (frame.wasOpen || frame.opened || frame.isOpen)
      ) {
        pendingRefresh = true;
      }

      if (frame.isOpen) return false;

      if (frame.closed) {
        const shouldRefresh = pendingRefresh || wantsRefresh;
        pendingRefresh = false;
        return shouldRefresh;
      }

      return wantsRefresh;
    },

    reset() {
      frameOpen = false;
      markerCarry = '';
      pendingRefresh = false;
    },
  };
}

function longestMarkerPrefixSuffix(value: string): string {
  const maxLength = Math.min(
    value.length,
    Math.max(...FRAME_MARKERS.map((marker) => marker.length)) - 1,
  );
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (FRAME_MARKERS.some((marker) => marker.startsWith(suffix))) {
      return suffix;
    }
  }
  return '';
}
