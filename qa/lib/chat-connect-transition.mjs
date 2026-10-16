// Pure analysis for the Chat full-connect-overlay frame probe.
// Page collection deliberately lives in the visual harness so this module can
// be tested without Electron or a DOM.

function elementKey(element = {}) {
  return element.selector
    || (element.testid ? `[data-testid="${element.testid}"]` : '')
    || (element.dataTestid ? `[data-testid="${element.dataTestid}"]` : '')
    || (Array.isArray(element.classes) && element.classes.length ? `.${element.classes.join('.')}` : '')
    || (typeof element.classes === 'string' && element.classes ? `.${element.classes.replace(/\s+/g, '.')}` : '')
    || element.tag
    || 'unknown';
}

function uniqueLeaks(leaks) {
  const seen = new Set();
  return leaks.filter(leak => {
    const key = `${leak.kind}:${elementKey(leak.element)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactElement(element = {}) {
  const classes = Array.isArray(element.classes)
    ? element.classes.join(' ')
    : (element.classes ?? element.className ?? '');
  const rect = element.rect ?? (Number.isFinite(element.left) ? {
    left: element.left, top: element.top, width: element.width, height: element.height,
  } : undefined);
  const text = String(element.text ?? element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return {
    selector: elementKey(element),
    ...(element.testid || element.dataTestid ? { testid: element.testid ?? element.dataTestid } : {}),
    ...(classes ? { classes } : {}),
    ...(rect ? { rect } : {}),
    ...(text ? { text } : {}),
  };
}

function isPaintedOutside(element = {}) {
  if (element.structural || element.visible === false || element.rendered === false
    || element.visibility === 'hidden' || element.display === 'none') return false;
  if (Number.isFinite(element.effectiveOpacity) && element.effectiveOpacity <= 0) return false;
  if (Number.isFinite(element.opacity) && element.opacity <= 0) return false;
  const rect = element.rect;
  return !rect || (!Number.isFinite(rect.width) || rect.width > 0) && (!Number.isFinite(rect.height) || rect.height > 0);
}

/**
 * Analyses one serialized animation frame. `fullOverlay` is intentionally the
 * mounted-mask flag, not opacity: an opacity-zero mask must still hide the
 * pane while its entrance animation starts.
 */
export function analyzeFrame(frame) {
  if (!frame?.fullOverlay) return { leaks: [], readinessGap: false };
  const leaks = [];
  for (const element of frame.gridTop ?? []) {
    if (!element?.structural) leaks.push({ kind: 'topmost', element });
  }
  // An inert element cannot win elementsFromPoint, but remains a visible leak
  // when it is painted above or through the full connecting mask.
  for (const element of frame.renderedOutside ?? []) {
    if (isPaintedOutside(element)) leaks.push({ kind: 'painted-outside', element });
  }
  const effectiveOpacity = Number(frame.overlayEffectiveOpacity ?? frame.overlayOpacity ?? 1);
  if (effectiveOpacity < 0.9) {
    for (const element of frame.renderedOutside ?? []) {
      if (isPaintedOutside(element)) leaks.push({ kind: 'fade-through', element });
    }
  }
  return { leaks: uniqueLeaks(leaks), readinessGap: false };
}

function successfulThreadId(row) {
  return row?.params?.result?.thread?.id ?? row?.result?.thread?.id;
}

function isCrash(row) {
  return row?.direction === 'fixture' && row?.method === 'crashed' && Number.isInteger(row?.pid);
}

/**
 * Finds the latest non-crashed fixture process that successfully opened the
 * requested native thread. Verification-only `thread/read` processes have no
 * opener and therefore cannot be selected.
 */
export function selectWorkerOwner(rows, nativeId) {
  if (!nativeId) return undefined;
  const crashed = new Set((rows ?? []).filter(isCrash).map(row => row.pid));
  for (let resultIndex = (rows?.length ?? 0) - 1; resultIndex >= 0; resultIndex -= 1) {
    const result = rows[resultIndex];
    if (result?.direction !== 'out' || successfulThreadId(result) !== nativeId || crashed.has(result.pid)) continue;
    for (let openerIndex = resultIndex - 1; openerIndex >= 0; openerIndex -= 1) {
      const opener = rows[openerIndex];
      if (opener?.pid !== result.pid) continue;
      if (opener.direction === 'in' && (opener.method === 'thread/start' || opener.method === 'thread/resume')) {
        return { pid: result.pid, opener, result, openerIndex, resultIndex };
      }
    }
  }
  return undefined;
}

/**
 * Returns the first provider-open request written after `afterIndex`. A
 * resumed thread must match `nativeId`; an unvisited new chat has no id until
 * its `thread/start` response and is intentionally accepted.
 */
export function fixtureConnectStarted(rows, afterIndex, nativeId) {
  for (let index = Math.max(-1, afterIndex) + 1; index < (rows?.length ?? 0); index += 1) {
    const row = rows[index];
    if (row?.direction !== 'in' || (row.method !== 'thread/start' && row.method !== 'thread/resume')) continue;
    const threadId = row.params?.threadId;
    if (nativeId && threadId && threadId !== nativeId) continue;
    return row;
  }
  return undefined;
}

/** The fixture's pre-exit log can precede worker death. All I/O and waiting are
 * injected so this crash-only bounded retry is testable without a process. */
export async function waitForNonReadyConnection(read, wait, maxAttempts = 40) {
  let state;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    state = await read();
    if (['disconnected', 'connecting', 'failed'].includes(state.phase)) return state;
    if (attempt + 1 < maxAttempts) await wait(50);
  }
  throw new Error(`Crashed fixture remained ${state?.phase ?? 'unknown'} after ${maxAttempts} health checks`);
}

function timeOf(frame, fallback) {
  return Number.isFinite(frame?.time) ? frame.time : fallback;
}

// Older callers only provide fullOverlay. A banner is still an overlay for
// exit-readiness purposes, even though it does not participate in mask-leak
// detection.
function overlayMounted(frame) {
  return frame?.fullOverlay === true || frame?.overlayPresent === true;
}

function summarizeOccurrences(occurrences, overlayStart) {
  const grouped = new Map();
  for (const occurrence of occurrences) {
    const key = `${occurrence.kind}:${elementKey(occurrence.element)}:${occurrence.interval ?? ''}`;
    const prior = grouped.get(key);
    if (prior) {
      prior.lastMs = occurrence.time - overlayStart;
    } else {
      grouped.set(key, {
        kind: occurrence.kind,
        element: compactElement(occurrence.element),
        firstMs: occurrence.time - overlayStart,
        lastMs: occurrence.time - overlayStart,
      });
    }
  }
  return [...grouped.values()];
}

/**
 * Summarizes overlay intervals. Readiness is considered only after an overlay
 * has been observed and removed, which avoids treating pre-mount frames as an
 * exit flash. It is suppressed while either a full mask or a banner remains
 * mounted. A composer is always required; transcript readiness is required
 * only by frames that expect a transcript.
 */
export function summarizeFrames(frames) {
  const ordered = [...(frames ?? [])];
  const firstOverlayIndex = ordered.findIndex(overlayMounted);
  if (firstOverlayIndex < 0) return { leaks: [], fadeCandidates: [], overlay: undefined };

  const overlayStart = timeOf(ordered[firstOverlayIndex], firstOverlayIndex);
  let lastOverlayIndex = firstOverlayIndex;
  const occurrences = [];
  for (let index = firstOverlayIndex; index < ordered.length; index += 1) {
    const frame = ordered[index];
    if (overlayMounted(frame)) lastOverlayIndex = index;
    const analysis = analyzeFrame(frame);
    const time = timeOf(frame, index);
    for (const leak of analysis.leaks) occurrences.push({ ...leak, time });
  }

  const readiness = [];
  const resolvedAt = new Map();
  let checkingExit = true;
  let exitInterval = 0;
  for (let index = firstOverlayIndex + 1; index < ordered.length; index += 1) {
    const frame = ordered[index] ?? {};
    if (overlayMounted(frame)) {
      checkingExit = true;
      exitInterval += 1;
      continue;
    }
    if (!checkingExit) continue;
    const needsTranscript = frame.expectsTranscript === true;
    const missingComposer = frame.composerReady !== true;
    const missingTranscript = needsTranscript && frame.transcriptReady !== true;
    if (!missingComposer && !missingTranscript) {
      resolvedAt.set(exitInterval, timeOf(frame, index));
      checkingExit = false;
      continue;
    }
    readiness.push({
      kind: 'exit-not-ready',
      element: {
        selector: '.chat-view',
        text: [missingComposer && 'composer', missingTranscript && 'transcript'].filter(Boolean).join(' + ') + ' not ready',
      },
      time: timeOf(frame, index),
      interval: exitInterval,
    });
  }

  const summarized = summarizeOccurrences(occurrences, overlayStart);
  // A composer that becomes editable within two frames (34 ms) of the overlay leaving is not a visible flash.
  // Anything slower, or an exit that never becomes ready (end of samples or the overlay returning), still fails.
  const firstGap = new Map();
  for (const gap of readiness) if (!firstGap.has(gap.interval)) firstGap.set(gap.interval, gap.time);
  const visibleReadiness = readiness.filter(gap => !resolvedAt.has(gap.interval) || resolvedAt.get(gap.interval) - firstGap.get(gap.interval) > 34);
  const readinessGaps = summarizeOccurrences(visibleReadiness, overlayStart);
  const entryGaps = summarizeOccurrences(ordered.slice(0, firstOverlayIndex).filter(frame => frame.panePresent === true
    && frame.composerReady !== true && (frame.emptyStateVisible === true || frame.transcriptReady === true)).map(frame => ({
    kind: 'entry-not-ready', time: frame.time,
    element: { selector: frame.emptyStateVisible ? '.chat-view .v3-empty' : '.chat-view .v3-message-text', rect: frame.paneRect, text: 'content visible before connecting mask' },
  })), overlayStart);
  return {
    leaks: [...entryGaps, ...summarized.filter(leak => leak.kind !== 'fade-through'), ...readinessGaps],
    fadeCandidates: summarized.filter(leak => leak.kind === 'fade-through'),
    overlay: {
      firstMs: 0,
      lastMs: timeOf(ordered[lastOverlayIndex], lastOverlayIndex) - overlayStart,
    },
  };
}
