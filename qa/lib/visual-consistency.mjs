// Shared visual-consistency helper (issue VC, step V1).
//
// `checkControlConsistency(page, containerSelector)` collects the visible
// buttons, [role=button] elements and chips inside a container, groups them by
// row (same DOM parent and an overlapping vertical band) and compares the
// rendered control geometry inside each group. It also checks that every
// control gets a focus-visible outline and that disabled controls do not change
// on hover.
//
// The grouping/comparison half is pure so it can be unit-tested without a
// browser (`qa/visual-consistency.test.mjs`). `tokenLintDiff(diffText)` is the
// companion CSS token lint: it fails on hex/rgb/hsl colour literals in lines
// added by this task. The unit test runs it against
// `git diff 846c272 -- '*.css'`.

/** Default chip/control selector. Keep in sync with the shared .chip spec. */
export const CONTROL_SELECTOR = 'button, [role="button"], .chip';

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
export function compareGroup(group) {
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
  return violations.filter(Boolean);
}

/** Analyses a raw control list (as returned by the page evaluate). */
export function analyzeControls(controls) {
  const violations = [];
  for (const group of groupControls(controls)) violations.push(...compareGroup(group));
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
export function collectControlsInPage({ containerSelector, controlSelector }) {
  const root = containerSelector ? document.querySelector(containerSelector) : document.body;
  if (!root) return { error: `container not found: ${containerSelector}` };
  const all = [...root.querySelectorAll(controlSelector || 'button, [role="button"], .chip')];
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
    let focusVisibleOutline = null;
    if (typeof element.focus === 'function') {
      try {
        element.focus({ preventScroll: true });
        if (element.matches(':focus-visible')) {
          focusVisibleOutline = parseFloat(window.getComputedStyle(element).outlineWidth) || 0;
        }
        element.blur();
      } catch {
        focusVisibleOutline = null;
      }
    }
    let probe;
    if (disabled) {
      probe = String(probeIndex++);
      element.setAttribute('data-vc-probe', probe);
    }
    controls.push({
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
  return { controls, error: undefined };
}

function sameStyle(a, b) {
  return a.backgroundColor === b.backgroundColor
    && a.color === b.color
    && a.borderTopColor === b.borderTopColor
    && a.opacity === b.opacity;
}

/**
 * Checks a container for control-consistency violations.
 * Returns `{ violations, checked, groups, error? }`; never throws on a missing
 * container (the caller can assert on `error`).
 */
export async function checkControlConsistency(page, containerSelector, options = {}) {
  const controlSelector = options.controlSelector ?? CONTROL_SELECTOR;
  const collected = await page
    .evaluate(collectControlsInPage, { containerSelector: containerSelector ?? null, controlSelector })
    .catch(error => ({ error: String(error), controls: [] }));
  if (collected.error) return { violations: [], checked: 0, groups: [], error: collected.error };
  const controls = collected.controls ?? [];
  const groups = groupControls(controls);
  const violations = analyzeControls(controls);

  // Disabled controls must not react to hover. The collect pass tagged each one
  // with data-vc-probe so the selector stays unambiguous.
  const probes = controls.filter(control => control.probe !== undefined);
  for (const control of probes) {
    const locator = page.locator(`[data-vc-probe="${control.probe}"]`);
    const before = await locator
      .evaluate(element => {
        const style = window.getComputedStyle(element);
        return { backgroundColor: style.backgroundColor, color: style.color, borderTopColor: style.borderTopColor, opacity: style.opacity };
      })
      .catch(() => null);
    if (!before) continue;
    await locator.hover({ force: true }).catch(() => undefined);
    const after = await locator
      .evaluate(element => {
        const style = window.getComputedStyle(element);
        return { backgroundColor: style.backgroundColor, color: style.color, borderTopColor: style.borderTopColor, opacity: style.opacity };
      })
      .catch(() => before);
    if (!sameStyle(before, after)) {
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
