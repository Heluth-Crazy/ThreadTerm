import type { PageRect, PageTargetRef } from '@threadterm/protocol';
/** Runs inside the untrusted preview frame. Keep every helper inside this function: it is sent with toString(). */
export function pagePickerScript(
  action: 'pick' | 'cancel' | 'mark' | 'at' | 'inspect',
  target?: PageTargetRef,
  flash?: boolean,
  point?: { x: number; y: number },
  edit?: { property?: string; value?: string; revert?: boolean; mode?: 'element'|'area'; zh?:boolean; pins?: Array<{number:number;target:PageTargetRef}> },
): unknown {
  const key = Symbol.for('threadterm.pagePicker');
  type Control = {
    cancel?: () => void;
    mark?: (t?: PageTargetRef, f?: boolean) => boolean;
    clear?: () => void;
    pins?: (pins: Array<{number:number;target:PageTargetRef}>) => void;
    css?: Map<string,{element:HTMLElement;property:string;before:string;inline:string;priority:string}>;
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
  const copy=(en:string,cn:string)=>edit?.zh?cn:en;
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
    for (let n: Element | null = e; n && n !== document.documentElement && p.join(' > ').length <= 500; n = n.parentElement) {
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
    const computedStyles: Record<string,string> = {}, styles: Record<string,string> = {};
    if (!pass(e)) try {
      const style=getComputedStyle(e);
      for(const name of ['color','background-color','font-size','font-family','display','position']) computedStyles[name]=clean(style.getPropertyValue(name),1000);
      for(let index=0;index<style.length&&index<300;index++){const name=style.item(index);if(/^[a-z-]{1,80}$/.test(name))styles[name]=clean(style.getPropertyValue(name),1000);}
    } catch {}
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
      ...(Object.keys(computedStyles).length?{computedStyles}:{}),
      ...(Object.keys(styles).length?{styles}:{}),
      ...hints(e),
    };
  };
  let markHost: HTMLElement | undefined, pinHost: HTMLElement | undefined, pinUpdate: (()=>void) | undefined,
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
  const setPins = (pins: Array<{number:number;target:PageTargetRef}>) => {
    if(pinUpdate){window.removeEventListener('scroll',pinUpdate,true);window.removeEventListener('resize',pinUpdate);pinUpdate=undefined;}
    pinHost?.remove(); pinHost=undefined;
    if (!pins.length) return;
    const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    const origin={x:window.scrollX,y:window.scrollY}, badges:Array<{badge:HTMLElement;element:Element|null;rect:PageRect}>=[];
    for(const pin of pins) {
      let element: Element|null=null;try{element=pin.target.selector?document.querySelector(pin.target.selector):null;}catch{}
      const rect=element?box(element.getBoundingClientRect()):pin.target.rect;
      if(!rect)continue;
      const badge=document.createElement('span');badge.textContent=String(pin.number);badge.style.cssText=`position:fixed;left:${rect.x}px;top:${rect.y}px;transform:translate(-45%,-45%);min-width:18px;height:18px;border-radius:9px;background:Highlight;color:HighlightText;text-align:center;font:12px/18px system-ui;box-shadow:0 0 0 2px Canvas;`;
      host.append(badge);badges.push({badge,element,rect});
    }
    pinUpdate=()=>{for(const pin of badges){const rect=pin.element?.isConnected?box(pin.element.getBoundingClientRect()):{...pin.rect,x:pin.rect.x-(window.scrollX-origin.x),y:pin.rect.y-(window.scrollY-origin.y)};pin.badge.style.left=`${rect.x}px`;pin.badge.style.top=`${rect.y}px`;}};pinUpdate();
    document.documentElement.append(host);pinHost=host;window.addEventListener('scroll',pinUpdate,true);window.addEventListener('resize',pinUpdate);
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
    const pins=edit?.pins, pinControl=old?.pins??setPins;
    w[key] = { ...old, mark, clear, pins:pinControl };
    if(pins) pinControl(pins);
    return mark(target, flash);
  }
  if (action === 'at') {
    old?.cancel?.();
    old?.clear?.();
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x<0 || point.y<0 || point.x>innerWidth || point.y>innerHeight) return null;
    const element = document.elementsFromPoint(point.x, point.y).find((value) => value instanceof Element);
    return element ? {
      url: location.href,
      title: clean(document.title, 200),
      viewport: { width: innerWidth, height: innerHeight },
      target: picked(element),
    } : null;
  }
  if (action === 'inspect') {
    if (!target?.selector) return null;
    let element: Element | null = null; try { element=document.querySelector(target.selector); } catch { return null; }
    if (!element || pass(element)) return null;
    const history=old?.css??new Map<string,{element:HTMLElement;property:string;before:string;inline:string;priority:string}>();
    w[key]={...old,css:history};
    if(edit?.revert&&!edit.property){for(const item of history.values()){if(item.inline)item.element.style.setProperty(item.property,item.inline,item.priority);else item.element.style.removeProperty(item.property);}history.clear();}
    const property=edit?.property, node=element as HTMLElement, keyFor=property?`${target.selector}\0${property}`:'';
    if(property&&/^[a-z-]{1,80}$/.test(property)) {
      let item=history.get(keyFor);
      if(!item||item.element!==node||!item.element.isConnected){if(item?.element.isConnected){if(item.inline)item.element.style.setProperty(item.property,item.inline,item.priority);else item.element.style.removeProperty(item.property);}item={element:node,property,before:clean(getComputedStyle(node).getPropertyValue(property),1000),inline:node.style.getPropertyValue(property),priority:node.style.getPropertyPriority(property)};history.set(keyFor,item);}
      if(edit?.revert){if(item.inline)node.style.setProperty(property,item.inline,item.priority);else node.style.removeProperty(property);history.delete(keyFor);}
      else if(typeof edit.value==='string')node.style.setProperty(property,clean(edit.value,1000));
    }
    const result=picked(element) as {styles?:Record<string,string>};
    return {styles:result.styles??{},cssEdits:[...history.values()].map(item=>({property:item.property,before:item.before,after:clean(getComputedStyle(item.element).getPropertyValue(item.property),1000)}))};
  }
  old?.cancel?.();
  old?.clear?.();
  return new Promise((resolve) => {
    let done = false,
      hover: Element | null = null,
      selections: ReturnType<typeof picked>[] = [],
      textEdits: Array<{selector:string;before:string;after:string}> = [],
      clickTimer: ReturnType<typeof setTimeout> | undefined,
      editor: HTMLTextAreaElement | undefined,
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
      finish = (v: unknown, delayed = false) => {
        if (done) return;
        done = true;
        if(clickTimer)clearTimeout(clickTimer);
        editor?.remove();editor=undefined;
        off();
        const tail = (e: Event) => stop(e);
        for (const t of ['click', 'mousedown', 'mouseup', 'pointerup', 'touchend'])
          window.addEventListener(t, tail, true);
        host.remove();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
          previousFocus.focus({ preventScroll: true });
        if(delayed){for(const t of ['click','mousedown','mouseup','pointerup','touchend'])window.removeEventListener(t,tail,true);if(w[key]===controller)delete w[key];resolve(v);return;}
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            for (const t of ['click', 'mousedown', 'mouseup', 'pointerup', 'touchend'])
              window.removeEventListener(t, tail, true);
            if (w[key] === controller) delete w[key];
            resolve(v);
          }),
        );
      };
    const finishElements = (current?: Element, delayed = false) => {
      if(current) { const value=picked(current); if(!selections.some(item=>item.selector===value.selector)) selections.push(value); }
      const primary=selections[0]??(hover?picked(hover):undefined);
      if(!primary)return finish(null);
      finish({url:location.href,title:clean(document.title,200),viewport:{width:innerWidth,height:innerHeight},target:primary,...(selections.length?{elements:selections}:{}),...(textEdits.length?{textEdits}:{})},delayed);
    };
    const editText = () => {
      if(!hover||pass(hover))return;
      if(hover.children.length)return;
      const before=clean(hover.textContent,1000); if(!before)return;
      const rect=hover.getBoundingClientRect(); editor=document.createElement('textarea');
      editor.value=before;editor.maxLength=1000;editor.setAttribute('aria-label',copy('Edit page text','编辑页面文字'));editor.style.cssText=`position:fixed;z-index:2147483647;left:${rect.left}px;top:${rect.top}px;width:${Math.max(80,rect.width)}px;height:${Math.max(28,rect.height)}px;box-sizing:border-box;font:inherit;`;
      document.documentElement.append(editor);editor.focus();
      const close=(keep:boolean)=>{const after=clean(editor!.value,10000);editor!.remove();editor=undefined;if(keep&&after!==before){hover!.textContent=after;const selector=sel(hover!);if(selector)textEdits.push({selector,before,after});finishElements(hover!);}else host.focus({preventScroll:true});};
      editor.addEventListener('keydown',(event:KeyboardEvent)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();close(true);}else if(event.key==='Escape'){event.preventDefault();close(false);}});
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
        if(clickTimer){clearTimeout(clickTimer);clickTimer=undefined;}
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
            target: (()=>{const dx=e.clientX-s.x,dy=e.clientY-s.y;if(e.altKey)return areaPick({x:s.x-dx,y:s.y-dy},{x:s.x+dx,y:s.y+dy});if(e.shiftKey)return Math.abs(dx)>=Math.abs(dy)?areaPick(s,{x:e.clientX,y:s.y+(dy<0?-1:1)}):areaPick(s,{x:s.x+(dx<0?-1:1),y:e.clientY});return areaPick(s,{x:e.clientX,y:e.clientY});})(),
          });
        else if (edit?.mode==='area') {
          chip.textContent='Drag to mark an area';
        } else if (hover) {
          if(e.altKey) return finish({url:location.href,title:clean(document.title,200),viewport:{width:innerWidth,height:innerHeight},target:picked(hover),toChat:true});
          if(e.shiftKey) { const value=picked(hover);if(!selections.some(item=>item.selector===value.selector))selections.push(value);chip.textContent=copy(`${selections.length} selected · Enter to continue`,`已选择 ${selections.length} 个 · 按 Enter 继续`);return; }
          const pickedHover=hover;clickTimer=setTimeout(()=>finishElements(pickedHover,true),180);
        }
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
    cover.addEventListener('dblclick', (event:MouseEvent)=>{stop(event);if(clickTimer){clearTimeout(clickTimer);clickTimer=undefined;}editText();}, true);
    cover.addEventListener('wheel', wheel, { capture: true, passive: false });
    const keys = (e: KeyboardEvent) => {
      if(editor&&e.target===editor)return;
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
      } else if(e.key==='Enter'&&selections.length){stop(e);finishElements();}
    };
    window.addEventListener('keydown', keys, true);
    off = () => window.removeEventListener('keydown', keys, true);
    controller = { cancel: () => finish(null), mark, clear, pins:old?.pins };
    w[key] = controller;
    if(edit?.mode==='area') chip.textContent=copy('Drag to mark an area','拖动以标记区域');
    paint(under(point.x, point.y));
  });
}
export function pagePickerSource(action: 'pick' | 'cancel' | 'mark' | 'at' | 'inspect', target?: PageTargetRef, flash?: boolean, point?: { x: number; y: number }, edit?: { property?: string; value?: string; revert?: boolean; mode?: 'element'|'area'; zh?:boolean; pins?: Array<{number:number;target:PageTargetRef}> }): string {
  const encoded = (value: unknown) => JSON.stringify(value) ?? 'undefined';
  const args = [encoded(action), encoded(target), encoded(flash)];
  if (point) args.push(JSON.stringify(point));
  else if(edit) args.push('undefined');
  if(edit) args.push(JSON.stringify(edit));
  return `(${pagePickerScript.toString()})(${args.join(',')})`;
}
