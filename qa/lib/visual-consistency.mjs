// Shared visual-consistency helper (issue VC, step V1).
//
// `checkControlConsistency(page, containerSelector)` collects the visible
// buttons, [role=button] elements and chips inside a container, groups them by
// row (same DOM parent and an overlapping vertical band) and compares the
// rendered control geometry inside each group. It also checks that every
// control gets a focus-visible outline and that disabled controls do not change
// on hover. Opt in with { checkStates: true, checkDisabledRows: true } to also
// compare selected siblings and hover backgrounds of disabled input rows.
//
// The grouping/comparison half is pure so it can be unit-tested without a
// browser (`qa/visual-consistency.test.mjs`). `tokenLintDiff(diffText)` is the
// companion CSS token lint: it fails on hex/rgb/hsl colour literals in lines
// added by this task. The unit test runs it against
// `git diff 846c272 -- '*.css'`.
//
// `paneStripViolations(rows)` is the companion family rule set: since T1 every
// pane owns its own Chrome-style tab strip, which is a different family from the
// 38 px docked panel headers, so a strip is never measured with the docked
// header rules and the two are never compared with each other.

/**
 * Default chip/control selector. Keep in sync with the shared .chip spec. Inline file links
 * (`.file-reference-link`) are text, not controls, so they never join a control row.
 */
export const CONTROL_SELECTOR = 'button:not(.file-reference-link), [role="button"], .chip';

/** Pixel tolerance for "the same" height / centre. */
export const HEIGHT_TOLERANCE = 0.5;
export const CENTER_TOLERANCE = 1.5;

/** An icon-only control is compared to other icon controls for
 *  font/padding/border; text controls are compared to text controls. Height,
 *  radius and the vertical centre are compared across the whole row. */
export function controlVariant(control) {
  return control.iconOnly ? 'icon' : 'text';
}

function valueViolation(kind, group, values) {
  const unique = [...new Set(values.map(value => (typeof value === 'number' ? Number(value.toFixed(2)) : value)))];
  if (unique.length <= 1) return undefined;
  return {
    kind,
    parent: group.parentPath,
    message: `${kind} differs inside one row: ${unique.join(', ')}`,
    values: unique,
    controls: group.controls.map(control => control.selector),
  };
}

/**
 * Groups controls into visual rows: an overlapping vertical band inside the
 * checked container. Controls that share an overlapping band are one row. A
 * floating control joins the ordinary row or card it overlaps (for example the
 * "Back to bottom" overlay), while an unpaired overlay stays isolated.
 */
export function groupControls(controls) {
  const sorted = [...controls].sort((a, b) => a.top - b.top);
  const groups = [];
  for (const control of sorted) {
    if (control.floating) continue;
    const band = groups.find(candidate =>
      control.top < candidate.bottom - 0.5 && control.bottom > candidate.top + 0.5);
    if (band) {
      band.controls.push(control);
      band.top = Math.min(band.top, control.top);
      band.bottom = Math.max(band.bottom, control.bottom);
    } else {
      groups.push({
        parentKey: control.parentKey,
        parentPath: control.parentPath,
        top: control.top,
        bottom: control.bottom,
        controls: [control],
      });
    }
  }
  for (const control of sorted.filter(candidate => candidate.floating)) {
    const band = groups.find(candidate =>
      control.top < candidate.bottom - 0.5 && control.bottom > candidate.top + 0.5);
    if (band) {
      band.controls.push(control);
      band.top = Math.min(band.top, control.top);
      band.bottom = Math.max(band.bottom, control.bottom);
    } else {
      groups.push({
        parentKey: control.parentKey,
        parentPath: control.parentPath,
        floating: true,
        top: control.top,
        bottom: control.bottom,
        controls: [control],
      });
    }
  }
  return groups;
}

/** Compares the controls inside one row group and returns violations. */
export function compareGroup(group, options = {}) {
  const violations = [];
  if (group.controls.length < 2) return violations;
  const heights = group.controls.map(control => control.height);
  if (Math.max(...heights) - Math.min(...heights) > HEIGHT_TOLERANCE) {
    violations.push(valueViolation('height', group, heights));
  }
  const centers = group.controls.map(control => control.centerY);
  if (Math.max(...centers) - Math.min(...centers) > CENTER_TOLERANCE) {
    violations.push(valueViolation('vertical-centre', group, centers));
  }
  const radii = group.controls.map(control => control.borderRadius);
  if (new Set(radii.map(value => Number(value.toFixed(2)))).size > 1) {
    violations.push(valueViolation('border-radius', group, radii));
  }
  for (const variant of ['text', 'icon']) {
    const peers = group.controls.filter(control => controlVariant(control) === variant);
    if (peers.length < 2) continue;
    const like = { ...group, controls: peers };
    violations.push(
      valueViolation('font-size', like, peers.map(control => control.fontSize)),
      valueViolation('padding', like, peers.map(control => `${control.paddingLeft}/${control.paddingRight}`)),
      valueViolation('border-width', like, peers.map(control => control.borderTopWidth)),
    );
  }
  if (options.checkStates) {
    for (const control of group.controls.filter(candidate => candidate.on === true)) {
      // Geometry groups can span multiple parents. State peers must be actual
      // siblings with the same shared variant, not unrelated controls in a band.
      const peers = group.controls.filter(candidate => candidate.on === false
        && candidate.parentKey === control.parentKey
        && controlVariant(candidate) === controlVariant(control)
        && candidate.stateVariant === control.stateVariant
        && candidate.disabled === control.disabled);
      const identical = peers.filter(peer => ['backgroundColor', 'color', 'borderColor', 'boxShadow']
        .every(property => control[property] === peer[property]));
      if (identical.length) violations.push({
        kind: 'state', parent: control.parentPath,
        message: `${control.selector} looks identical to off siblings of the same variant`,
        controls: [control.selector, ...identical.map(peer => peer.selector)],
      });
    }
  }
  return violations.filter(Boolean);
}

/** Analyses a raw control list (as returned by the page evaluate). */
export function analyzeControls(controls, options = {}) {
  const violations = [];
  for (const group of groupControls(controls)) violations.push(...compareGroup(group, options));
  for (const control of controls) {
    if (control.focusVisibleOutline !== null && control.focusVisibleOutline <= 0) {
      violations.push({
        kind: 'focus-visible',
        parent: control.parentPath,
        message: `${control.selector} has no focus-visible outline`,
        controls: [control.selector],
      });
    }
  }
  return violations;
}

/** Collects the control geometry in the page. Serialized and run in Chromium. */
export function collectControlsInPage({ containerSelector, containerIndex = 0, controlSelector, checkStates = false, checkDisabledRows = false }) {
  // A repeated container (one pane strip per pane) is addressed by index, so several
  // rows of the same surface can be measured without inventing a selector per row.
  const root = containerSelector ? document.querySelectorAll(containerSelector)[containerIndex] : document.body;
  if (!root) return { error: `container not found: ${containerSelector}${containerIndex ? ` [${containerIndex}]` : ''}` };
  const all = [...root.querySelectorAll(controlSelector || 'button:not(.file-reference-link), [role="button"], .chip')];
  const parentIds = new WeakMap();
  let nextParentId = 0;
  const nameOf = element => {
    const tag = element.tagName.toLowerCase();
    const cls = typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
    return tag + cls;
  };
  const cssPath = element => {
    const label = element.getAttribute('aria-label');
    return `${nameOf(element)}${label ? `[aria-label="${label.slice(0, 30)}"]` : ''}`;
  };
  const isVisible = element => {
    if (element.closest('[inert]')) return false;
    if (element.hidden) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // A control scrolled out of a clipped ancestor still has a rect; skip it.
    let clipped = rect;
    for (let node = element.parentElement; node; node = node.parentElement) {
      const parentStyle = window.getComputedStyle(node);
      const clips = /(auto|scroll|hidden|clip)/.test(parentStyle.overflowY) || /(auto|scroll|hidden|clip)/.test(parentStyle.overflowX);
      if (!clips) continue;
      const bounds = node.getBoundingClientRect();
      clipped = {
        top: Math.max(clipped.top, bounds.top),
        bottom: Math.min(clipped.bottom, bounds.bottom),
        left: Math.max(clipped.left, bounds.left),
        right: Math.min(clipped.right, bounds.right),
      };
    }
    return clipped.bottom - clipped.top >= rect.height - 0.5 && clipped.right - clipped.left >= rect.width - 0.5;
  };
  const controls = [];
  let probeIndex = 0;
  for (const element of all) {
    if (!isVisible(element)) continue;
    const parent = element.parentElement;
    if (!parent) continue;
    if (!parentIds.has(parent)) parentIds.set(parent, nextParentId++);
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    const disabled = element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
    const state = checkStates ? {
      on: ['aria-pressed', 'aria-expanded', 'aria-checked'].some(attribute => element.getAttribute(attribute) === 'true') || element.classList.contains('is-on'),
      stateVariant: [...element.classList].filter(name => /^(btn(?:-.+)?|icon-btn(?:-.+)?|chip(?:-btn)?|is-plain|is-icon)$/.test(name)).sort().join(' '),
      backgroundColor: style.backgroundColor, color: style.color, borderColor: style.borderColor, boxShadow: style.boxShadow,
    } : {};
    let focusVisibleOutline = null;
    if (typeof element.focus === 'function') {
      const selection = document.getSelection();
      let savedRange = null;
      if (selection && selection.rangeCount === 1) {
        try { savedRange = selection.getRangeAt(0).cloneRange(); } catch { savedRange = null; }
      }
      try {
        element.focus({ preventScroll: true });
        if (element.matches(':focus-visible')) {
          focusVisibleOutline = parseFloat(window.getComputedStyle(element).outlineWidth) || 0;
        }
        element.blur();
      } catch {
        focusVisibleOutline = null;
      }
      // Measuring the outline must not leave the user's selection cleared.
      if (savedRange) {
        const live = document.getSelection();
        try { live?.removeAllRanges(); live?.addRange(savedRange); } catch { /* The measured node may have replaced the range. */ }
      }
    }
    let probe;
    if (disabled) {
      probe = String(probeIndex++);
      element.setAttribute('data-vc-probe', probe);
    }
    controls.push({
      ...state,
      selector: cssPath(element),
      parentKey: parentIds.get(parent),
      parentPath: nameOf(parent),
      disabled,
      probe,
      floating: style.position === 'absolute' || style.position === 'fixed',
      iconOnly: text.length === 0,
      top: rect.top,
      bottom: rect.bottom,
      centerY: rect.top + rect.height / 2,
      height: rect.height,
      fontSize: parseFloat(style.fontSize) || 0,
      borderRadius: parseFloat(style.borderTopLeftRadius) || 0,
      paddingLeft: parseFloat(style.paddingLeft) || 0,
      paddingRight: parseFloat(style.paddingRight) || 0,
      borderTopWidth: parseFloat(style.borderTopWidth) || 0,
      focusVisibleOutline,
    });
  }
  const disabledRows = [];
  if (checkDisabledRows) {
    for (const element of root.querySelectorAll('label, [role="option"], [role="menuitemradio"]')) {
      if (!element.querySelector('input:disabled') || !isVisible(element)) continue;
      const probe = String(probeIndex++);
      element.setAttribute('data-vc-probe', probe);
      disabledRows.push({ selector: cssPath(element), parentPath: nameOf(element.parentElement ?? root), probe, hoverOnly: true });
    }
  }
  return { controls, ...(checkDisabledRows ? { disabledRows } : {}), error: undefined };
}

function sameStyle(a, b) {
  return a.backgroundColor === b.backgroundColor
    && a.color === b.color
    && a.borderTopColor === b.borderTopColor
    && a.opacity === b.opacity;
}

/**
 * Whether a hover changed a control that is *still* disabled. A control that
 * became enabled while the probe was hovering (state settled after the first
 * paint) is not a disabled-hover bug, so it is never reported.
 */
export function disabledHoverChanged(before, after) {
  if (!after || after.disabled === false) return false;
  return !sameStyle(before, after);
}

/** Disabled input rows are checked for background changes only. */
export function disabledRowHoverChanged(before, after) {
  return Boolean(before?.disabled && after?.disabled && before.backgroundColor !== after.backgroundColor);
}

/**
 * Checks a container for control-consistency violations.
 * Returns `{ violations, checked, groups, error? }`; never throws on a missing
 * container (the caller can assert on `error`).
 */
export async function checkControlConsistency(page, containerSelector, options = {}) {
  const controlSelector = options.controlSelector ?? CONTROL_SELECTOR;
  // State paint is compared at rest, not with one sibling under the pointer.
  if (options.checkStates) await page.mouse.move(0, 0);
  const collected = await page
    .evaluate(collectControlsInPage, { containerSelector: containerSelector ?? null, containerIndex: options.index ?? 0, controlSelector, checkStates: options.checkStates === true, checkDisabledRows: options.checkDisabledRows === true })
    .catch(error => ({ error: String(error), controls: [] }));
  if (collected.error) return { violations: [], checked: 0, groups: [], error: collected.error };
  const controls = collected.controls ?? [];
  const groups = groupControls(controls);
  const violations = analyzeControls(controls, options);

  // Disabled controls must not react to hover. The collect pass tagged each one
  // with data-vc-probe so the selector stays unambiguous. A control whose state
  // settles after the first paint (for example a question card that enables
  // once its lease lands) is re-probed once and skipped if it stays enabled.
  const probes = [...controls.filter(control => control.probe !== undefined), ...(collected.disabledRows ?? [])];
  const readProbe = (locator, hoverOnly) => locator
    .evaluate((element, isRow) => {
      const style = window.getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderTopColor: style.borderTopColor,
        opacity: style.opacity,
        disabled: isRow ? Boolean(element.querySelector('input:disabled')) : element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      };
    }, Boolean(hoverOnly))
    .catch(() => null);
  for (const control of probes) {
    const locator = page.locator(`[data-vc-probe="${control.probe}"]`);
    if (options.checkDisabledRows) await page.mouse.move(0, 0);
    if (control.hoverOnly) await locator.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))).catch(() => undefined);
    const before = await readProbe(locator, control.hoverOnly);
    if (!before?.disabled) continue;
    await locator.hover({ force: true }).catch(() => undefined);
    if (control.hoverOnly) await locator.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))).catch(() => undefined);
    let after = await readProbe(locator, control.hoverOnly);
    if (after && !after.disabled) {
      await locator.hover({ force: true }).catch(() => undefined);
      after = await readProbe(locator, control.hoverOnly);
      if (!after?.disabled) continue;
    }
    if (control.hoverOnly ? disabledRowHoverChanged(before, after) : disabledHoverChanged(before, after)) {
      violations.push({
        kind: 'disabled-hover',
        parent: control.parentPath,
        message: `${control.selector} changes on hover while disabled`,
        controls: [control.selector],
      });
    }
  }
  if (probes.length) {
    await page.evaluate(() => document.querySelectorAll('[data-vc-probe]').forEach(node => node.removeAttribute('data-vc-probe'))).catch(() => undefined);
  }

  return {
    violations,
    checked: controls.length,
    ...(options.checkDisabledRows ? { disabledRowsChecked: (collected.disabledRows ?? []).length } : {}),
    groups: groups.map(group => ({ parent: group.parentPath, size: group.controls.length })),
  };
}

/** Asserts zero violations. `label` is used in the error message. */
export function assertNoControlViolations(result, label = 'surface') {
  if (result.error) throw new Error(`${label}: ${result.error}`);
  if (result.violations.length) {
    const lines = result.violations.map(violation => `  - [${violation.kind}] ${violation.parent ? `${violation.parent}: ` : ''}${violation.message}${violation.controls?.length ? ` (${violation.controls.join(', ')})` : ''}`);
    throw new Error(`${label}: ${result.violations.length} control-consistency violation(s):\n${lines.join('\n')}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Panel families: docked headers (38 px, panel-headers.css) and pane tab strips
// (43 px Chrome-style tabs, T1 / workspace-parity.css) are measured by different
// rule sets. `qa/panel-consistency-visual.mjs` runs both.
// ---------------------------------------------------------------------------

/** Docked panel headers keep the shared 38 px header scale and 26 px icon actions
 *  (`panel-headers.css`); `qa/panel-consistency-visual.mjs` asserts those directly. */

/** Every pane owns a 43 px tab strip, whatever content the pane shows. */
export const PANE_STRIP_HEIGHT = 43;
/** Icon actions inside a pane strip (add, split, overflow, close) share 28 px. */
export const PANE_STRIP_CONTROL_HEIGHT = 28;

/**
 * T1 tab geometry: idle tabs are 32 px tall with 8 px shoulders, the selected tab
 * is 33 px and merges into the panel edge, its target is 30 px and the row's icon
 * buttons are 28 px. The selected tab keeps room for a readable label.
 */
export const PANE_TAB_GEOMETRY = {
  height: 32,
  activeHeight: 33,
  selectHeight: 30,
  closeHeight: 28,
  shoulder: 8,
  activeMinWidth: 120,
};

/** Families whose rows are pane tab strips rather than docked panel headers. */
export const PANE_STRIP_FAMILIES = ['pane', 'browser-tabs'];

/**
 * Control selector inside a pane strip. A button tucked into a tab (the tab
 * target and its close) is part of the tab shape and follows the tab geometry, so
 * it never joins a strip control row.
 */
export const PANE_STRIP_CONTROL_SELECTOR = 'button:not(.workspace-tab-select):not(.workspace-tab-close), [role="button"]';

export const isPaneStrip = row => PANE_STRIP_FAMILIES.includes(row.family);

const round = value => Math.round(Number(value) * 10) / 10;

/** The geometry every pane strip of one theme must share. */
export function paneStripSignature(row) {
  return JSON.stringify({
    height: round(row.rect.height),
    padding: row.padding,
    gap: row.gap,
    background: row.background,
    border: row.border,
    radius: row.radius,
  });
}

function stripControlErrors(row) {
  const errors = [];
  const controls = (row.controls ?? []).filter(control => control.inTab !== true);
  for (const control of controls) {
    if (Math.abs(control.height - PANE_STRIP_CONTROL_HEIGHT) > HEIGHT_TOLERANCE) {
      errors.push(`strip control height ${round(control.height)} != ${PANE_STRIP_CONTROL_HEIGHT}: ${control.label}`);
    }
  }
  const radii = [...new Set(controls.map(control => round(parseFloat(control.radius) || 0)))];
  if (radii.length > 1) errors.push(`strip icon buttons disagree on radius: ${radii.join(', ')}`);
  return errors;
}

function tabGeometryErrors(row) {
  const errors = [];
  const tabs = row.tabs ?? [];
  const active = tabs.filter(tab => tab.active);
  if (tabs.length && active.length !== 1) errors.push(`${active.length} selected tabs in one strip`);
  for (const tab of tabs) {
    const kind = tab.active ? 'selected' : 'idle';
    const expected = tab.active ? PANE_TAB_GEOMETRY.activeHeight : PANE_TAB_GEOMETRY.height;
    if (Math.abs(tab.height - expected) > HEIGHT_TOLERANCE) errors.push(`${kind} tab height ${round(tab.height)} != ${expected}`);
    if (Math.abs(tab.radius[0] - PANE_TAB_GEOMETRY.shoulder) > HEIGHT_TOLERANCE
      || Math.abs(tab.radius[1] - PANE_TAB_GEOMETRY.shoulder) > HEIGHT_TOLERANCE
      || round(tab.radius[2]) !== 0 || round(tab.radius[3]) !== 0) {
      errors.push(`${kind} tab shoulders ${tab.radius.join(' ')} != ${PANE_TAB_GEOMETRY.shoulder}px ${PANE_TAB_GEOMETRY.shoulder}px 0 0`);
    }
    if (Math.abs(tab.selectHeight - PANE_TAB_GEOMETRY.selectHeight) > HEIGHT_TOLERANCE) {
      errors.push(`${kind} tab target height ${round(tab.selectHeight)} != ${PANE_TAB_GEOMETRY.selectHeight}`);
    }
    if (tab.closeHeight !== null && Math.abs(tab.closeHeight - PANE_TAB_GEOMETRY.closeHeight) > HEIGHT_TOLERANCE) {
      errors.push(`${kind} tab close button height ${round(tab.closeHeight)} != ${PANE_TAB_GEOMETRY.closeHeight}`);
    }
    if (!tab.active) continue;
    if (tab.width < PANE_TAB_GEOMETRY.activeMinWidth - HEIGHT_TOLERANCE) {
      errors.push(`selected tab width ${round(tab.width)} < ${PANE_TAB_GEOMETRY.activeMinWidth}`);
    }
    if (Math.abs(tab.bottom - row.rect.bottom) > 1) {
      errors.push(`selected tab does not merge into the panel edge: tab bottom ${round(tab.bottom)} vs strip bottom ${round(row.rect.bottom)}`);
    }
  }
  return errors;
}

/**
 * Pane tab strip rules for the rows of one capture. Returns `{ surface, errors }`
 * entries: every strip is 43 px, all strips of one theme agree on insets, surface
 * and rule (they sit on one row), strip controls share one size and radius, and the
 * tabs keep the T1 geometry with exactly one selected tab merging into its panel.
 */
export function paneStripViolations(rows) {
  const strips = rows.filter(isPaneStrip);
  const violations = [];
  if (!strips.length) return violations;
  const signatures = new Set(strips.map(paneStripSignature));
  if (signatures.size > 1) {
    violations.push({ surface: 'pane strips', errors: [`strip insets, surface and rule differ between panes: ${[...signatures].join(' | ')}`] });
  }
  const tops = strips.map(row => row.rect.y);
  if (Math.max(...tops) - Math.min(...tops) > 1) {
    violations.push({ surface: 'pane strips', errors: [`strips do not share one row: tops ${tops.map(round).join(', ')}`] });
  }
  for (const row of strips) {
    const errors = [];
    if (Math.abs(row.rect.height - PANE_STRIP_HEIGHT) > HEIGHT_TOLERANCE) {
      errors.push(`pane strip height ${round(row.rect.height)} != ${PANE_STRIP_HEIGHT}`);
    }
    errors.push(...stripControlErrors(row), ...tabGeometryErrors(row));
    if (errors.length) violations.push({ surface: row.surface, errors });
  }
  return violations;
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;

/**
 * Token lint over a unified diff. Only added lines (`+`, not `+++`) are
 * inspected. Returns `{ violations }`; each violation names the file, the new
 * line number and the literal that was matched.
 */
export function tokenLintDiff(diffText) {
  const violations = [];
  const lines = String(diffText).split(/\r?\n/);
  let file = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const content = line.slice(1);
    const matches = content.match(COLOR_LITERAL);
    if (matches) violations.push({ file, line: index + 1, content: content.trim(), matches });
  }
  return { violations };
}
