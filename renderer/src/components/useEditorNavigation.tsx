import { useEffect, useRef, useState, type RefObject, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { request } from '../bridge';
import { useMachines } from '../machines';
import { NavigationDocuments, navigationError, navigationKey, navigationLanguage, notifyNavigationGroup, releaseNavigationGroup, retainNavigationGroup, type NavigationBuffer, type NavigationGroup, type NavigationLocation } from '../editorNavigation';
import type { ContextMenuItem } from './ContextMenu';
import { EditorNavigationChooser, EditorNavigationSettings } from './EditorNavigationPanel';

type Options = {
  projectId: string; worktreePath?: string; ownerSessionId?: string; editorId?: string;
  path?: string; text: string; dirty: boolean; enabled: boolean; active: boolean; zh: boolean; bufferEligible: boolean;
  host: RefObject<HTMLElement | null>;
  persisted: () => NavigationBuffer[];
  open: (target: NavigationLocation, current: () => boolean) => Promise<boolean>;
};
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function useEditorNavigation(options: Options) {
  const machine = useMachines().currentId;
  const groupKey = JSON.stringify([machine, options.projectId, options.worktreePath ?? '', options.ownerSessionId ?? '']);
  const instance = useRef(crypto.randomUUID());
  const latest = useRef(options); latest.current = options;
  const group = useRef<NavigationGroup | undefined>(undefined);
  const versions = useRef(new NavigationDocuments());
  const token = useRef<{ id: string; language: string } | undefined>(undefined);
  const sequence = useRef(0), mounted = useRef(true), pending = useRef<{ contextId: string; requestId: string } | undefined>(undefined);
  const syncTail = useRef<Promise<unknown>>(Promise.resolve());
  const lastAction = useRef<{ kind: 'definition' | 'symbols'; position?: number } | undefined>(undefined);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<string>();
  const [chooser, setChooser] = useState<{ title: string; targets: NavigationLocation[]; origin: NavigationLocation; current: () => boolean; truncated: boolean }>();
  const [settings, setSettings] = useState(false);
  const [, refresh] = useState(0);
  const editor = () => {
    const dom = latest.current.host.current?.querySelector<HTMLElement>('.cm-content');
    return dom ? EditorView.findFromDOM(dom) : null;
  };
  const read = (): NavigationBuffer | undefined => {
    const value = latest.current;
    if (!value.bufferEligible || !value.path) return;
    const view = editor();
    const ready = Boolean(value.enabled && value.active && view && view.dom.getBoundingClientRect().width && !view.dom.closest('[inert]'));
    return { path: value.path, content: value.text, dirty: value.dirty, ready, reveal: location => {
      if (!value.enabled || !value.active || location.path !== value.path) return false;
      const view = editor();
      if (!view || !view.dom.getBoundingClientRect().width || view.dom.closest('[inert]')) return false;
      const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, location.line)));
      const pos = Math.min(line.to, line.from + Math.max(0, location.column - 1));
      const clamp = (offset: number) => Math.max(0, Math.min(view.state.doc.length, offset));
      const selection = location.anchor !== undefined && location.head !== undefined
        ? EditorSelection.single(clamp(location.anchor), clamp(location.head)) : EditorSelection.single(pos);
      view.dispatch({ selection, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      if (location.scrollTop !== undefined) requestAnimationFrame(() => { if (view.dom.isConnected) view.scrollDOM.scrollTop = location.scrollTop!; });
      view.focus();
      return true;
    } };
  };
  const invalidate = () => {
    group.current?.opening?.commitIfReady();
    sequence.current++;
    const active = pending.current; pending.current = undefined;
    if (active) void request('editorNavigation.cancel', active).catch(() => {});
  };
  const stop = async () => {
    invalidate();
    if (group.current) group.current.epoch++;
    const previous = token.current; token.current = undefined;
    if (mounted.current) { setBusy(false); setChooser(undefined); }
    if (previous) await request('editorNavigation.release', { contextId: previous.id }).catch(() => {});
  };
  useEffect(() => {
    mounted.current = true;
    const retained = retainNavigationGroup(groupKey, instance.current, read);
    group.current = retained;
    const changed = () => refresh(value => value + 1);
    retained.listeners.add(changed);
    return () => {
      mounted.current = false; invalidate();
      retained.listeners.delete(changed);
      releaseNavigationGroup(groupKey, instance.current);
      const previous = token.current; token.current = undefined;
      if (previous) void request('editorNavigation.release', { contextId: previous.id }).catch(() => {});
    };
  }, [groupKey]);
  useEffect(() => {
    invalidate(); setBusy(false); setChooser(undefined);
    lastAction.current = undefined;
  }, [options.path, options.active, options.enabled, groupKey]);
  useEffect(() => {
    const focus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('.editor-navigation-dialog')) return;
      const workspace = latest.current.host.current?.closest('.file-workspace');
      if (workspace?.contains(target)) return;
      invalidate(); setBusy(false); setChooser(undefined);
    };
    globalThis.document.addEventListener('focusin', focus);
    return () => globalThis.document.removeEventListener('focusin', focus);
  }, []);

  const snapshot = () => {
    const source = read();
    if (!source) throw new Error('navigation_unsupported');
    const buffers = [...(group.current?.buffers.values() ?? [])].flatMap(get => { const value = get(); return value ? [value] : []; });
    return versions.current.snapshot(source, latest.current.persisted(), buffers);
  };
  const sync = async (contextId: string) => {
    const documents = snapshot();
    const job = syncTail.current.catch(() => {}).then(() => request('editorNavigation.sync', { contextId, documents }));
    syncTail.current = job;
    await job;
    return documents;
  };
  // Live document updates only exist after an explicit semantic action. Editing alone starts nothing.
  useEffect(() => {
    if (!token.current || !options.enabled) return;
    invalidate(); setBusy(false); setChooser(undefined);
    const contextId = token.current.id;
    const timer = setTimeout(() => { if (token.current?.id === contextId) void sync(contextId).catch(() => {}); }, 200);
    return () => clearTimeout(timer);
  }, [options.text]);
  const location = (position?: number): NavigationLocation | undefined => {
    const view = editor(), path = latest.current.path;
    if (!view || !path) return;
    const selection = view.state.selection.main;
    const at = position ?? selection.head, line = view.state.doc.lineAt(at);
    return { path, line: line.number, column: at - line.from + 1, anchor: position ?? selection.anchor, head: position ?? selection.head, scrollTop: view.scrollDOM.scrollTop };
  };
  const openLocation = async (target: NavigationLocation, origin: NavigationLocation, current: () => boolean, delta?: -1 | 1) => {
    const scope = latest.current, retained = group.current;
    if (!retained || !current()) return;
    const epoch = retained.epoch;
    let complete = () => {};
    let armed = false, settled = false;
    const settle = () => {
      if (retained.opening === opening) retained.opening = undefined;
      if (!settled) { settled = true; complete(); }
    };
    const opening: NonNullable<NavigationGroup['opening']> = {
      targetPath: target.path,
      done: new Promise<void>(resolve => { complete = resolve; }),
      commitIfReady: () => {
        if (!armed || settled || retained.opening !== opening || !mounted.current || retained.epoch !== epoch) return false;
        if (![...retained.buffers.values()].some(get => { const buffer = get(); return buffer?.path === target.path && buffer.ready; })) return false;
        if (delta) retained.history.move(delta, origin); else retained.history.visit(origin, target);
        settle();
        notifyNavigationGroup(retained);
        return true;
      },
    };
    retained.opening = opening;
    try {
      const isOpen = [...retained.buffers.values()].some(get => get()?.path === target.path);
      // Validate a new target before changing tab/focus; this uses the selected local file backend too.
      if (!isOpen) await request('filesystem.read', { projectId: scope.projectId, worktreePath: scope.worktreePath, path: target.path });
      if (!current() || !await scope.open(target, current)) return;
      armed = true;
      // A typed host open mounts/reuses a normal source editor. Commit history only after it is usable.
      for (let attempt = 0; attempt < 80; attempt++) {
        if (retained.opening !== opening || !mounted.current || retained.epoch !== epoch) return;
        const targetBuffer = [...retained.buffers.values()].map(get => get()).find(buffer => buffer?.path === target.path && buffer.reveal?.(target));
        if (targetBuffer) {
          opening.commitIfReady();
          if (mounted.current) { setNotice(undefined); setChooser(undefined); }
          return;
        }
        await pause(50);
      }
      throw new Error(scope.zh ? '目标文件未能打开。' : 'The target file could not be opened.');
    } catch (error) { if (mounted.current) setNotice(navigationError(error, latest.current.zh)); }
    finally { settle(); }
  };
  const begin = () => {
    invalidate();
    const ticket = sequence.current, retained = group.current;
    const epoch = retained ? ++retained.epoch : 0;
    const source = latest.current, path = source.path, text = source.text;
    return () => mounted.current && sequence.current === ticket && group.current === retained && retained?.epoch === epoch && latest.current.path === path && latest.current.text === text && latest.current.active && latest.current.enabled;
  };
  const history = async (delta: -1 | 1) => {
    const retained = group.current, opening = retained?.opening, source = latest.current;
    // A host can focus its new tab before the open's readiness check commits history.
    if (retained && opening && opening.targetPath === source.path) {
      const ticket = sequence.current, epoch = retained.epoch;
      await opening.done;
      if (!mounted.current || sequence.current !== ticket || group.current !== retained || retained.epoch !== epoch
        || latest.current.path !== source.path || latest.current.text !== source.text || !latest.current.active || !latest.current.enabled) return;
    }
    const origin = location(), target = group.current?.history.target(delta);
    if (!origin || !target) return;
    await openLocation(target, origin, begin(), delta);
  };
  const run = async (kind: 'definition' | 'symbols', position?: number) => {
    const origin = location(position), source = latest.current;
    const language = source.path && navigationLanguage(source.path);
    if (!origin || !language || !source.enabled) return;
    const family = language === 'javascript' ? 'typescript' : language;
    lastAction.current = { kind, position };
    const current = begin(); setNotice(undefined); setChooser(undefined); setBusy(true);
    try {
      let context = token.current;
      if (context && context.language !== family) { await request('editorNavigation.release', { contextId: context.id }).catch(() => {}); context = undefined; token.current = undefined; }
      if (context) {
        try { const status = await request('editorNavigation.status', { contextId: context.id }); if (status.state === 'failed') throw new Error(status.message); }
        catch { await request('editorNavigation.release', { contextId: context.id }).catch(() => {}); context = undefined; token.current = undefined; }
      }
      if (!current()) return;
      if (!context) {
        const prepared = await request('editorNavigation.prepare', { projectId: source.projectId, worktreePath: source.worktreePath, bufferGroup: instance.current, language });
        if (!current()) { void request('editorNavigation.release', { contextId: prepared.contextId }).catch(() => {}); return; }
        context = { id: prepared.contextId, language: family }; token.current = context;
      }
      const deadline = Date.now() + 125_000;
      while (current()) {
        const status = await request('editorNavigation.status', { contextId: context.id });
        if (status.state === 'ready') break;
        if (status.state === 'failed') throw new Error(status.message ?? 'navigation_failed');
        if (Date.now() > deadline) throw new Error('navigation_timeout');
        setNotice(source.zh ? '正在准备语言服务…可以继续编辑，或取消本次查找。' : 'Preparing language service… You can keep editing or cancel this lookup.');
        await pause(250);
      }
      if (!current()) return;
      const documents = await sync(context.id);
      if (!current()) return;
      const version = documents.find(doc => doc.path === origin.path)!.version;
      const requestId = crypto.randomUUID(); pending.current = { contextId: context.id, requestId };
      const common = { contextId: context.id, path: origin.path, version, requestId };
      let targets: NavigationLocation[], truncated: boolean;
      if (kind === 'definition') {
        const result = await request('editorNavigation.definition', { ...common, line: origin.line, column: origin.column });
        targets = result.targets; truncated = result.truncated;
      } else {
        const result = await request('editorNavigation.documentSymbols', common);
        targets = result.symbols.map(symbol => ({ ...symbol, name: symbol.container ? `${symbol.container} · ${symbol.name}` : symbol.name })); truncated = result.truncated;
      }
      if (!current()) return;
      pending.current = undefined; setNotice(undefined);
      if (!targets.length) setNotice(source.zh ? (kind === 'symbols' ? '当前文件没有可显示的符号。' : '没有找到定义。') : (kind === 'symbols' ? 'No symbols in this file.' : 'No definition found.'));
      else if (kind === 'definition' && targets.length === 1) await openLocation(targets[0], origin, current);
      else setChooser({ title: source.zh ? (kind === 'symbols' ? '当前文件符号' : '选择定义') : (kind === 'symbols' ? 'Symbols in this file' : 'Choose definition'), targets, origin, current, truncated });
    } catch (error) {
      if (current()) {
        const failure = error instanceof Error ? error.message : String(error);
        if (/navigation_(server_failed|stale_context|foreign_context)/.test(failure)) {
          const failed = token.current; token.current = undefined;
          if (failed) await request('editorNavigation.release', { contextId: failed.id }).catch(() => {});
        }
        if (current()) setNotice(navigationError(error, source.zh));
      }
    }
    finally { if (current()) setBusy(false); }
  };
  const menuItems: ContextMenuItem[] = options.enabled ? [
    { id: 'navigation-definition', label: options.zh ? '跳转到定义' : 'Go to definition', shortcut: 'F12 / Ctrl+B', onSelect: () => run('definition') },
    { id: 'navigation-symbols', label: options.zh ? '当前文件符号' : 'File symbols', shortcut: 'Ctrl+F12', onSelect: () => run('symbols') },
    { id: 'navigation-back', label: options.zh ? '返回上一个位置' : 'Navigate back', shortcut: 'Ctrl+Alt+←', disabled: !group.current?.history.canBack, onSelect: () => history(-1) },
    { id: 'navigation-forward', label: options.zh ? '前进到下一个位置' : 'Navigate forward', shortcut: 'Ctrl+Alt+→', disabled: !group.current?.history.canForward, onSelect: () => history(1) },
    { id: 'navigation-settings', label: options.zh ? '语言服务设置' : 'Language services', onSelect: () => setSettings(true) },
  ] : [];
  const onKeyDownCapture = (event: ReactKeyboardEvent) => {
    if (!latest.current.enabled || !(event.target instanceof Element) || !event.target.closest('.cm-content')) return;
    const action = navigationKey(event.nativeEvent);
    if (!action) return;
    event.preventDefault(); event.stopPropagation();
    if (action === 'back' || action === 'forward') void history(action === 'back' ? -1 : 1); else void run(action);
  };
  const onClickCapture = (event: ReactMouseEvent) => {
    if (!latest.current.enabled || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('.cm-content')) return;
    const at = editor()?.posAtCoords({ x: event.clientX, y: event.clientY });
    if (at == null) return;
    event.preventDefault(); event.stopPropagation(); void run('definition', at);
  };
  const panel = <>
    {(busy || notice) && <div className="editor-navigation-status" role="status"><span>{notice ?? (options.zh ? '正在查找…' : 'Looking up…')}</span>{busy && <button className="btn btn-sm" onClick={() => { invalidate(); if (group.current) group.current.epoch++; setBusy(false); setNotice(undefined); }}>{options.zh ? '取消' : 'Cancel'}</button>}{!busy && lastAction.current && <button className="btn btn-sm" onClick={() => { const action = lastAction.current; if (action) void run(action.kind, action.position); }}>{options.zh ? '重试' : 'Retry'}</button>}<button className="btn btn-sm" onClick={() => setSettings(true)}>{options.zh ? '语言服务' : 'Language services'}</button><button className="btn btn-sm" onClick={() => void stop()}>{options.zh ? '停止服务' : 'Stop service'}</button>{!busy && <button className="btn btn-sm" onClick={() => setNotice(undefined)}>{options.zh ? '关闭' : 'Dismiss'}</button>}</div>}
    {chooser && <EditorNavigationChooser title={chooser.title} targets={chooser.targets} truncated={chooser.truncated} zh={options.zh} onClose={() => { setChooser(undefined); editor()?.focus(); }} onSelect={target => { const selected = chooser; setChooser(undefined); void openLocation(target, selected.origin, selected.current); }} />}
    {settings && <EditorNavigationSettings zh={options.zh} onClose={() => setSettings(false)} onChanged={() => void stop()} />}
  </>;
  return { menuItems, onKeyDownCapture, onClickCapture, panel, invalidate: () => { invalidate(); if (group.current) group.current.epoch++; } };
}
