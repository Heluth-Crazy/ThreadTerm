// Independent QA oracle for the brief-common.md estimator and display rules.
// Count Unicode code points (not UTF-16 code units), rounding each non-CJK run.
export function estimateOutputTokens(text) {
  const fullToken = point => (point >= 0x3400 && point <= 0x4dbf)
    || (point >= 0x4e00 && point <= 0x9fff) || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0x20000 && point <= 0x323af) || (point >= 0x3040 && point <= 0x30ff)
    || (point >= 0x31f0 && point <= 0x31ff) || (point >= 0x1b000 && point <= 0x1b16f)
    || (point >= 0x1100 && point <= 0x11ff) || (point >= 0x3130 && point <= 0x318f)
    || (point >= 0xa960 && point <= 0xa97f) || (point >= 0xac00 && point <= 0xd7af)
    || (point >= 0xd7b0 && point <= 0xd7ff) || (point >= 0xff01 && point <= 0xff60)
    || (point >= 0xffe0 && point <= 0xffe6);
  let tokens = 0, run = 0;
  const flush = () => { tokens += Math.ceil(run / 4); run = 0; };
  for (const character of text) {
    if (/\s/u.test(character)) flush();
    else if (fullToken(character.codePointAt(0))) { flush(); tokens += 1; }
    else run += 1;
  }
  flush();
  return tokens;
}

export function tokensPerSecond(outputTokens, generationMs) {
  if (!Number.isFinite(outputTokens) || !Number.isFinite(generationMs) || outputTokens < 1 || generationMs < 250) return null;
  return Math.round(outputTokens * 1000 / generationMs);
}

export function withinRelative(actual, expected, tolerance = 0.35) {
  return Number.isFinite(actual) && Number.isFinite(expected) && expected > 0 && Math.abs(actual - expected) <= expected * tolerance;
}

// The ±35% ranges overlap for this fixture. This second check rejects wall time
// as the denominator even when it falls inside the generous timing tolerance.
export function excludesToolTime(actual, outputTokens, generationMs, toolMs) {
  const effective = outputTokens * 1000 / generationMs;
  const wall = outputTokens * 1000 / (generationMs + toolMs);
  return withinRelative(actual, effective) && Math.abs(actual - effective) < Math.abs(actual - wall);
}

export function isolatedProviderEnvironment(base, { bin, nodeDir, system32 }) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^(?:path|home|userprofile|appdata|localappdata|codex_home)$/i.test(key) && !/^(?:threadterm_|tt_qa_)/i.test(key)));
  env.PATH = [bin, nodeDir, system32].join(';');
  return env;
}

export function transcriptAtBottom({ scrollTop, scrollHeight, clientHeight }, tolerance = 2) {
  return [scrollTop, scrollHeight, clientHeight].every(Number.isFinite) && clientHeight > 0
    && scrollTop >= 0 && scrollHeight - clientHeight - scrollTop <= tolerance;
}

export function transcriptFollowsLatest(sample) {
  return transcriptAtBottom(sample, 2) && !sample.jump.visible;
}

export function transcriptFollowSummary(samples) {
  const failed = samples.filter(sample => !transcriptFollowsLatest(sample));
  const worstSample = (failed.length ? failed : samples).reduce((worst, sample) => {
    const score = value => Number.isFinite(value.scrollHeight - value.clientHeight - value.scrollTop)
      ? Math.max(0, value.scrollHeight - value.clientHeight - value.scrollTop) + (value.jump.visible ? 0.001 : 0) : Infinity;
    return !worst || score(sample) > score(worst) ? sample : worst;
  }, null);
  return { sampleCount: samples.length, failureCount: failed.length, worstSample };
}

export function transcriptFollowFailure(label, samples) {
  const summary = transcriptFollowSummary(samples);
  return summary.failureCount ? `product: transcript stopped following during the turn at ${label}: ${JSON.stringify(summary.worstSample)}` : null;
}

// Self-contained page function: arm on actual submit, sample after rendering,
// and stop all QA observers/timers/frames at the completed-footer boundary.
export function observeTurnInPage(node, { id, label, footerCount }) {
  window.__tokenSpeedProbe?.stop('replaced');
  const probe = { id, label, samples: [], followSamples: [], absent: false, active: false, finished: false, startedAt: null, endedAt: null };
  let timer, frame, secondFrame, ending = false;
  const reasons = new Set();
  const measure = source => {
    const log = node.querySelector('.v3-chat-log'), control = node.querySelector('.chat-back-to-bottom');
    const rect = control?.getBoundingClientRect(), style = control ? getComputedStyle(control) : null;
    probe.followSamples.push({ at: Date.now(), source, scrollTop: log.scrollTop, scrollHeight: log.scrollHeight, clientHeight: log.clientHeight,
      remainingPx: log.scrollHeight - log.clientHeight - log.scrollTop,
      jump: { present: Boolean(control), visible: Boolean(rect && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible'),
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null } });
  };
  probe.stop = reason => {
    if (probe.finished) return;
    if (probe.active) measure(reason);
    probe.active = false; probe.finished = true; probe.endedAt = Date.now(); probe.stopReason = reason;
    clearInterval(timer); cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame);
    probe.observer.disconnect(); node.removeEventListener('submit', start, true);
  };
  const queue = source => {
    if (!probe.active) return;
    reasons.add(source);
    if (frame || secondFrame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      secondFrame = requestAnimationFrame(() => {
        secondFrame = null;
        const source = [...reasons].join(','); reasons.clear();
        if (ending) probe.stop('turn-end');
        else if (probe.active) measure(source);
      });
    });
  };
  const start = () => {
    if (probe.active || probe.finished) return;
    probe.active = true; probe.startedAt = Date.now();
    node.removeEventListener('submit', start, true);
    timer = setInterval(() => queue('interval-250ms'), 250);
    queue('send');
  };
  const sample = () => {
    const element = node.querySelector('[data-testid="turn-speed-live"]');
    if (!element) probe.absent = true;
    else {
      const value = { at: Date.now(), speed: Number(element.dataset.tokensPerSecond), estimated: element.dataset.estimated, text: element.textContent };
      const previous = probe.samples.at(-1);
      if (!previous || previous.speed !== value.speed || previous.estimated !== value.estimated || probe.absent) { probe.samples.push(value); queue('live-change'); }
      probe.absent = false;
    }
    if (probe.active && !element && node.querySelectorAll('[data-testid="turn-speed"]').length > footerCount) { ending = true; queue('turn-end'); }
  };
  probe.observer = new MutationObserver(sample);
  probe.observer.observe(node, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-estimated', 'data-tokens-per-second'] });
  node.addEventListener('submit', start, true);
  window.__tokenSpeedProbe = probe; sample();
}

// Only the initial no-control path may scroll directly. A timeout gets one
// diagnostic click on the product control; unresolved state is a product failure.
export async function ensureTranscriptLatest({ label, measure, clickJump, scrollToBottom, settle, onDiagnostic, timeoutMs = 30_000, pollMs = 80, now = Date.now, pause = ms => new Promise(done => setTimeout(done, ms)) }) {
  const diagnostic = { label, status: 'pending', tolerancePx: 2 };
  const publish = () => onDiagnostic(diagnostic);
  const ready = state => transcriptAtBottom(state, 2) && !state.jump.visible;
  publish();
  await settle();
  diagnostic.before = await measure();
  diagnostic.method = diagnostic.before.jump.present && diagnostic.before.jump.visible ? 'jump-to-latest' : 'scroll-to-bottom';
  publish();
  try {
    if (diagnostic.method === 'jump-to-latest') await clickJump();
    else await scrollToBottom();
  } catch (error) { diagnostic.initialActionError = error.message ?? String(error); }
  const deadline = now() + timeoutMs;
  for (;;) {
    await settle(); diagnostic.last = await measure(); publish();
    if (ready(diagnostic.last)) {
      await settle(); diagnostic.last = await measure();
      if (ready(diagnostic.last)) { diagnostic.status = 'ready'; publish(); return diagnostic.last; }
    }
    if (now() >= deadline) break;
    await pause(pollMs);
  }
  diagnostic.status = 'timed-out';
  diagnostic.timeout = await measure();
  diagnostic.retry = { before: diagnostic.timeout, attempted: false, succeeded: false, clickError: null };
  publish();
  if (diagnostic.retry.before.jump.present) {
    diagnostic.retry.attempted = true; publish();
    try { await clickJump(); diagnostic.retry.succeeded = true; }
    catch (error) { diagnostic.retry.clickError = error.message ?? String(error); }
  }
  await settle(); diagnostic.retry.after = await measure();
  await settle(); diagnostic.last = await measure();
  diagnostic.retry.settled = diagnostic.last;
  if (ready(diagnostic.retry.after) && ready(diagnostic.last)) {
    diagnostic.status = 'ready-after-timeout-click'; publish(); return diagnostic.last;
  }
  diagnostic.status = 'product-failure'; publish();
  throw new Error(`product: transcript cannot reach latest at ${label}: ${JSON.stringify(diagnostic.last)}; diagnosticClick=${JSON.stringify({ attempted: diagnostic.retry.attempted, error: diagnostic.retry.clickError })}`);
}

// Runs inside the page. innerText omits ::before/::after, so collect generated
// separators as well as DOM text, skipping segments hidden by container rules.
export function collectFooterPresentationInPage(footer) {
  const row = footer.querySelector('.chat-turn-meta');
  if (!row) return { error: 'footer has no metadata row', text: '', tokens: [] };
  const tokens = [], ids = new Map();
  const identify = node => {
    if (!ids.has(node)) ids.set(node, `${node.tagName.toLowerCase()}.${String(node.className).trim().replace(/\s+/g, '.')}:${ids.size}`);
    return ids.get(node);
  };
  const append = (text, source) => {
    for (const part of text.split(/(·)/)) {
      if (!part.trim()) continue;
      const kind = part === '·' ? 'separator' : 'segment';
      const previous = tokens.at(-1);
      if (kind === 'segment' && previous?.kind === kind && previous.source === source) previous.text += part;
      else tokens.push({ kind, text: part.trim(), source });
    }
  };
  const generated = (node, pseudo) => {
    const style = getComputedStyle(node, pseudo), content = style.content;
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || content === 'none' || content === 'normal') return;
    const text = content.replace(/^["']|["']$/g, '').replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)));
    append(text, `${identify(node)}${pseudo}`);
  };
  const walk = (node, owner) => {
    if (node.nodeType === 3) { append(node.textContent ?? '', owner); return; }
    if (node.nodeType !== 1) return;
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return;
    if (style.display !== 'contents' && (rect.width <= 0 || rect.height <= 0)) return;
    const source = node.matches('.chat-turn-segment') ? identify(node) : owner ?? identify(node);
    generated(node, '::before');
    for (const child of node.childNodes) walk(child, source);
    generated(node, '::after');
  };
  walk(row, null);
  return { text: row.innerText.trim(), tokens, renderedText: tokens.map(token => token.text).join(' ') };
}

export function footerSeparatorViolations({ text, tokens, error }) {
  if (error) return [error];
  const issues = [];
  if (/^·|·$/.test(text.trim())) issues.push('footer DOM text has a leading or trailing separator');
  if (!tokens.some(token => token.kind === 'segment')) issues.push('footer has no visible metadata segment');
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index], previous = tokens[index - 1], next = tokens[index + 1];
    if (token.kind === 'separator' && (previous?.kind !== 'segment' || next?.kind !== 'segment')) issues.push(`separator ${index} is not between two visible segments (${token.source})`);
    if (token.kind === 'segment' && previous?.kind === 'segment') issues.push(`visible segments ${index - 1} and ${index} lack a separator`);
  }
  return issues;
}

// Preserve the native row/reason and RPC errors instead of a bare timeout. The
// injected clock and pause keep failure-path regression tests deterministic.
export async function waitForProviderChat({ provider, readProviders, onDiagnostic, label = `${provider} Chat discovered`, timeoutMs = 30_000, pollMs = 80, now = Date.now, pause = ms => new Promise(done => setTimeout(done, ms)) }) {
  const deadline = now() + timeoutMs;
  let attempts = 0, providers = [], requestError = null;
  for (;;) {
    attempts += 1;
    try {
      const result = await readProviders();
      if (!Array.isArray(result)) throw new Error('provider.list returned a non-array result');
      providers = result; requestError = null;
    } catch (error) {
      requestError = { name: error?.name ?? 'Error', message: error?.message ?? String(error), code: error?.code ?? null };
    }
    const row = providers.find(row => row.id === provider) ?? null;
    const ready = requestError === null && row?.chat === true;
    const timedOut = !ready && now() >= deadline;
    onDiagnostic({ provider, attempts, at: now(), row, providers, probeError: row?.chat ? null : row?.reason ?? null, requestError, timedOut });
    if (ready) return row;
    if (timedOut) throw new Error(`Timed out: ${label}; ${requestError?.message ?? row?.reason ?? (row ? `installed=${row.installed}, auth=${row.auth}, chat=${row.chat}` : 'provider.list contains no matching row')}`);
    await pause(pollMs);
  }
}
