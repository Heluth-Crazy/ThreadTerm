import type { PageTargetRef } from '@threadterm/protocol';
/** Runs inside the untrusted preview frame. Keep every helper inside this function: it is sent with toString(). */
export function pagePickerScript(
  action: 'pick' | 'cancel' | 'mark',
  target?: PageTargetRef,
  flash?: boolean,
): Promise<unknown> | boolean {
  const key = Symbol.for('threadterm.pagePicker');
  type Control = {
    cancel?: () => void;
    mark?: (t?: PageTargetRef, f?: boolean) => boolean;
    clear?: () => void;
  };
  const w = window as unknown as Window & {
      [key: symbol]: Control | undefined;
    },
    old = w[key];
  if (action === 'cancel') {
    old?.cancel?.();
    return true;
  }
  const clean = (v: unknown, n: number) =>
    typeof v === 'string'
      ? v
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, n)
      : '';
  const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
  const box = (r: DOMRect | ClientRect) => ({
    x: r.left,
    y: r.top,
    width: Math.max(0, r.width),
    height: Math.max(0, r.height),
  });
  const pass = (e: Element) =>
    e.tagName.toLowerCase() === 'input' && clean(e.getAttribute('type'), 20).toLowerCase() === 'password';
  const esc = (v: string) => (window.CSS?.escape ? window.CSS.escape(v) : v.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const sel = (e: Element) => {
    const one = (s: string) => {
      try {
        return (
          s.length > 0 &&
          s.length <= 500 &&
          document.querySelectorAll(s).length === 1 &&
          document.querySelector(s) === e
        );
      } catch {
        return false;
      }
    };
    if (!pass(e) && e.id && one(`#${esc(e.id)}`)) return `#${esc(e.id)}`;
    if (e === document.documentElement && one('html')) return 'html';
    if (!pass(e))
      for (const n of ['data-testid', 'data-test', 'data-cy']) {
        const v = e.getAttribute(n),
          s = v ? `[${n}="${esc(v)}"]` : '';
        if (one(s)) return s;
      }
    const p: string[] = [];
    for (let n: Element | null = e; n && n !== document.documentElement && p.length < 6; n = n.parentElement) {
      const same = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n!.tagName) : [];
      p.unshift(
        same.length > 1 ? `${n.tagName.toLowerCase()}:nth-of-type(${same.indexOf(n) + 1})` : n.tagName.toLowerCase(),
      );
      const s = p.join(' > ');
      if (one(s)) return s;
    }
    const s = p.join(' > ');
    return one(s) ? s : '';
  };
  const attrs = (e: Element) => {
    const out: Record<string, string> = {};
    if (pass(e)) return out;
    for (const n of [
      'id',
      'class',
      'data-testid',
      'data-test',
      'data-cy',
      'name',
      'type',
      'role',
      'aria-label',
      'href',
      'src',
      'alt',
      'placeholder',
      'title',
    ]) {
      const v = e.getAttribute(n);
      if (v !== null) out[n] = clean(v, 300);
    }
    return out;
  };
  const label = (e: Element) => {
    const tag = e.tagName.toLowerCase();
    if (pass(e)) return 'input';
    const role =
      clean(e.getAttribute('role'), 40) ||
      (['button', 'a', 'img', 'input', 'select', 'textarea'].includes(tag) ? tag : '');
    const name = clean(
      e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('title') || e.textContent,
      110,
    );
    if (tag === 'a' && name)
      return `${role || 'a'} "${name}"${e.getAttribute('href') ? ` → ${clean(e.getAttribute('href'), 80)}` : ''}`.slice(
        0,
        160,
      );
    return role && name
      ? `${role} "${name}"`.slice(0, 160)
      : clean(
          `${tag}${e.id ? `#${e.id}` : ''}${e.classList.length ? `.${Array.from(e.classList).slice(0, 2).join('.')}` : ''}`,
          160,
        );
  };
  const hints = (e: Element): Record<string, unknown> => {
    if (pass(e)) return {};
    try {
      const comps: string[] = [];
      const add = (v: unknown) => {
        const s = clean(v, 80);
        if (s && !comps.includes(s) && comps.length < 6) comps.push(s);
      };
      const pos = (v: unknown) => (Number.isSafeInteger(v) && Number(v) > 0 ? Number(v) : undefined);
      let source: unknown;
      const set = (f: unknown, l: unknown, c: unknown, framework: string) => {
        const file = clean(f, 400);
        if (file)
          source = { file, ...(pos(l) ? { line: pos(l) } : {}), ...(pos(c) ? { column: pos(c) } : {}), framework };
      };
      const file = e.getAttribute('data-inspector-relative-path') || e.getAttribute('data-source-file'),
        packed = e.getAttribute('data-insp-path') || e.getAttribute('data-v-inspector');
      if (file)
        set(
          file,
          Number(e.getAttribute('data-inspector-line') || e.getAttribute('data-source-line')),
          Number(e.getAttribute('data-inspector-column')),
          'attribute',
        );
      else if (packed) {
        const m = packed.match(/^(.*?):(\d+)(?::(\d+))?$/);
        if (m) set(m[1], Number(m[2]), m[3] ? Number(m[3]) : undefined, 'attribute');
      }
      const r = e as Element & Record<string, unknown>,
        k = Object.keys(r).find((n) => n.startsWith('__reactFiber$'));
      if (k) {
        let f = r[k] as
          | {
              type?: {
                displayName?: unknown;
                name?: unknown;
              };
              return?: unknown;
              _debugSource?: {
                fileName?: unknown;
                lineNumber?: unknown;
                columnNumber?: unknown;
              };
            }
          | undefined;
        for (let i = 0; f && i < 12; i++, f = f.return as typeof f) {
          add(f.type?.displayName || f.type?.name);
          if (!source && f._debugSource?.fileName)
            set(f._debugSource.fileName, f._debugSource.lineNumber, f._debugSource.columnNumber, 'react');
        }
      }
      const vue = r.__vueParentComponent as
        | {
            type?: {
              __name?: unknown;
              name?: unknown;
              __file?: unknown;
            };
          }
        | undefined;
      if (vue) {
        add(vue.type?.__name || vue.type?.name);
        if (!source && vue.type?.__file) set(vue.type.__file, undefined, undefined, 'vue');
      }
      const sv = r.__svelte_meta as
        | {
            loc?: {
              file?: unknown;
              line?: unknown;
              column?: unknown;
            };
          }
        | undefined;
      if (!source && sv?.loc?.file) set(sv.loc.file, sv.loc.line, sv.loc.column, 'svelte');
      return { ...(source ? { source } : {}), ...(comps.length ? { components: comps } : {}) };
    } catch {
      return {};
    }
  };
  const picked = (e: Element) => {
    const a = attrs(e),
      text = pass(e) ? '' : clean(e.textContent, 200),
      tag = e.tagName.toLowerCase(),
      html = (v: string) =>
        v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return {
      type: 'element',
      selector: sel(e),
      tag,
      label: label(e),
      ...(text ? { text } : {}),
      attributes: a,
      html: clean(
        `<${tag}${Object.entries(a)
          .map(([k, v]) => ` ${k}="${html(v)}"`)
          .join('')}>${html(text)}`,
        600,
      ),
      rect: box(e.getBoundingClientRect()),
      ...hints(e),
    };
  };
  let markHost: HTMLElement | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    update: (() => void) | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (update) {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    }
    update = undefined;
    markHost?.remove();
    markHost = undefined;
  };
  const mark = (r?: PageTargetRef, f?: boolean) => {
    clear();
    if (!r) return true;
    let e: Element | undefined;
    if (r.selector)
      try {
        e = document.querySelector(r.selector) || undefined;
      } catch {
        return false;
      }
    if ((r.selector && !e) || (!e && !r.rect)) return false;
    if (e && f) e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    markHost = document.createElement('div');
    markHost.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;outline:3px solid #5b8cff;outline-offset:2px;border-radius:2px;';
    update = () => {
      if (e && !e.isConnected) {
        if (markHost) markHost.style.display = 'none';
        return;
      }
      const b = e ? box(e.getBoundingClientRect()) : r.rect;
      if (b && markHost) {
        markHost.style.left = `${b.x}px`;
        markHost.style.top = `${b.y}px`;
        markHost.style.width = `${b.width}px`;
        markHost.style.height = `${b.height}px`;
      }
    };
    update();
    document.documentElement.append(markHost);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    if (f) timer = setTimeout(clear, 1500);
    return true;
  };
  if (action === 'mark') {
    old?.clear?.();
    w[key] = { ...old, mark, clear };
    return mark(target, flash);
  }
  old?.cancel?.();
  old?.clear?.();
  return new Promise((resolve) => {
    let done = false,
      hover: Element | null = null,
      down: {
        x: number;
        y: number;
      } | null = null,
      point = { x: innerWidth / 2, y: innerHeight / 2 },
      off = () => {},
      controller: Control;
    const host = document.createElement('div');
    const previousFocus = document.activeElement;
    host.tabIndex = -1;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:auto;cursor:crosshair;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>:host{all:initial}#cover{position:fixed;inset:0;touch-action:none}#box{position:fixed;border:2px solid #5b8cff;background:#5b8cff18;pointer-events:none}#chip{position:fixed;max-width:360px;background:#15213b;color:white;padding:3px 6px;font:12px system-ui;pointer-events:none}#area{position:fixed;border:2px dashed #5b8cff;background:#5b8cff18;display:none;pointer-events:none}</style><div id="cover"></div><div id="box"></div><div id="chip"></div><div id="area"></div>';
    document.documentElement.append(host);
    host.focus({ preventScroll: true });
    const cover = shadow.querySelector('#cover') as HTMLElement,
      border = shadow.querySelector('#box') as HTMLElement,
      chip = shadow.querySelector('#chip') as HTMLElement,
      area = shadow.querySelector('#area') as HTMLElement,
      under = (x: number, y: number) =>
        document.elementsFromPoint(x, y).find((n) => n !== host && !host.contains(n) && n instanceof Element) || null,
      stop = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      },
      paint = (e: Element | null) => {
        hover = e;
        if (!e) {
          border.style.display = 'none';
          chip.style.display = 'none';
          return;
        }
        const r = e.getBoundingClientRect();
        border.style.cssText += `;display:block;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
        chip.textContent = `${label(e)} · ${Math.round(r.width)}×${Math.round(r.height)}`;
        chip.style.cssText += `;display:block;left:${clamp(r.left, 0, Math.max(0, innerWidth - 360))}px;top:${clamp(r.top - 25, 0, Math.max(0, innerHeight - 25))}px`;
      },
      finish = (v: unknown) => {
        if (done) return;
        done = true;
        off();
        const tail = (e: Event) => stop(e);
        for (const t of ['click', 'mousedown', 'mouseup', 'pointerup', 'touchend'])
          window.addEventListener(t, tail, true);
        host.remove();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
          previousFocus.focus({ preventScroll: true });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            for (const t of ['click', 'mousedown', 'mouseup', 'pointerup', 'touchend'])
              window.removeEventListener(t, tail, true);
            if (w[key] === controller) delete w[key];
            resolve(v);
          }),
        );
      };
    const areaPick = (
      s: {
        x: number;
        y: number;
      },
      e: {
        x: number;
        y: number;
      },
    ) => {
      const x = Math.min(s.x, e.x),
        y = Math.min(s.y, e.y),
        width = Math.abs(s.x - e.x),
        height = Math.abs(s.y - e.y),
        seen = new Set<Element>(),
        elements: string[] = [];
      for (const dx of [0.17, 0.5, 0.83])
        for (const dy of [0.17, 0.5, 0.83]) {
          let n = under(x + width * dx, y + height * dy);
          while (n && /^(HTML|BODY)$/i.test(n.tagName)) n = null;
          while (n?.parentElement) {
            try {
              const st = getComputedStyle(n);
              if (
                ['button', 'a', 'input', 'select', 'textarea'].includes(n.tagName.toLowerCase()) ||
                !/^inline/.test(st.display)
              )
                break;
            } catch {
              break;
            }
            n = n.parentElement;
          }
          if (n && /^(HTML|BODY)$/i.test(n.tagName)) n = null;
          if (n && !seen.has(n) && elements.length < 8) {
            seen.add(n);
            const l = label(n);
            if (l) elements.push(l);
          }
        }
      return {
        type: 'area',
        rect: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
        elements,
      };
    };
    const move = (e: PointerEvent) => {
        stop(e);
        const moved = point.x !== e.clientX || point.y !== e.clientY;
        point = { x: e.clientX, y: e.clientY };
        if (down) {
          const x = Math.min(down.x, e.clientX),
            y = Math.min(down.y, e.clientY);
          area.style.cssText += `;display:block;left:${x}px;top:${y}px;width:${Math.abs(e.clientX - down.x)}px;height:${Math.abs(e.clientY - down.y)}px`;
        } else if (moved || !hover) paint(under(e.clientX, e.clientY));
      },
      start = (e: PointerEvent) => {
        stop(e);
        if (!hover || point.x !== e.clientX || point.y !== e.clientY) paint(under(e.clientX, e.clientY));
        point = { x: e.clientX, y: e.clientY };
        down = { x: e.clientX, y: e.clientY };
        cover.setPointerCapture(e.pointerId);
      },
      end = (e: PointerEvent) => {
        stop(e);
        const s = down;
        down = null;
        area.style.display = 'none';
        if (!s) return;
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 5)
          finish({
            url: location.href,
            title: clean(document.title, 200),
            viewport: { width: innerWidth, height: innerHeight },
            target: areaPick(s, { x: e.clientX, y: e.clientY }),
          });
        else if (hover)
          finish({
            url: location.href,
            title: clean(document.title, 200),
            viewport: { width: innerWidth, height: innerHeight },
            target: picked(hover),
          });
      },
      wheel = (e: WheelEvent) => {
        stop(e);
        const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1,
          top = e.deltaY * m,
          left = e.deltaX * m;
        let n = under(e.clientX, e.clientY);
        while (n) {
          try {
            const st = getComputedStyle(n);
            if (
              /(auto|scroll)/.test(st.overflowX + st.overflowY) &&
              (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)
            ) {
              n.scrollTop += top;
              n.scrollLeft += left;
              paint(under(point.x, point.y));
              return;
            }
          } catch {}
          n = n.parentElement;
        }
        window.scrollBy({ top, left });
        requestAnimationFrame(() => paint(under(point.x, point.y)));
      };
    for (const t of ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'touchstart', 'touchmove', 'touchend'])
      cover.addEventListener(t, stop, true);
    cover.addEventListener('pointermove', move, true);
    cover.addEventListener('pointerdown', start, true);
    cover.addEventListener('pointerup', end, true);
    cover.addEventListener('wheel', wheel, { capture: true, passive: false });
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stop(e);
        finish(null);
      } else if (e.key === 'ArrowUp' && hover?.parentElement) {
        stop(e);
        paint(hover.parentElement);
      } else if (e.key === 'ArrowDown' && hover) {
        stop(e);
        const p = under(point.x, point.y);
        if (p && hover.contains(p)) {
          let c: Element = p;
          while (c.parentElement && c.parentElement !== hover) c = c.parentElement;
          if (c.parentElement === hover) paint(c);
        }
      }
    };
    window.addEventListener('keydown', keys, true);
    off = () => window.removeEventListener('keydown', keys, true);
    controller = { cancel: () => finish(null), mark, clear };
    w[key] = controller;
    paint(under(point.x, point.y));
  });
}
export function pagePickerSource(action: 'pick' | 'cancel' | 'mark', target?: PageTargetRef, flash?: boolean): string {
  return `(${pagePickerScript.toString()})(${JSON.stringify(action)},${JSON.stringify(target)},${JSON.stringify(flash)})`;
}
