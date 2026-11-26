import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderCapability } from '@threadterm/protocol';
import { AgentIconsProvider } from '../components/PrototypeIcon';
import { Island, IslandProvider, useIsland, useIslandActions, type ActivityOptions } from './engine';
import { finishedContent, runningContent, waitingContent, type Actions } from './content';
import { desktopMetrics, desktopMotion } from './desktopTuning';
import type { IslandModel } from './model';
import { islandWords } from './words';

/* The task island window's page: main sends the model, this keeps islandcn's activities in step with it, tells main
   when the pointer is over the island (so clicks land there and pass through everywhere else), and reports drags. */

const bridge = window.threadtermIsland;
/** The pending "pointer left the island" collapse; a new alert cancels it so it never cuts an alert short. */
const leave = { timer: 0 };
/** When the last drag moved; the island's own tap fires on release, before the window hears pointerup. */
const dragged = { at: 0 };

export function IslandApp() {
  const [model, setModel] = useState<IslandModel>();
  useEffect(() => bridge?.onModel(setModel), []);
  const providers = useMemo(() => (model?.providers ?? []) as unknown as ProviderCapability[], [model?.providers]);
  return <AgentIconsProvider providers={providers}>
    <IslandProvider metrics={desktopMetrics} motion={desktopMotion}>
      <Stage visible={model?.visible === true} zh={model?.zh === true} />
      {model && <IslandSync model={model} />}
    </IslandProvider>
  </AgentIconsProvider>;
}

interface Desired { id: string; sig: string; options: ActivityOptions; alert: boolean }

function IslandSync({ model }: { model: IslandModel }) {
  const island = useIslandActions();
  const shown = useRef(new Map<string, string>());
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const words = islandWords(model.zh);
    const actions: Actions = {
      open: key => { bridge?.open(key); island.collapse(); },
      later: () => island.collapse(),
      openApp: () => { bridge?.openApp(); island.collapse(); },
    };
    const press = (id: string) => () => { if (Date.now() - dragged.at > 300) island.expand(id); };
    const running = model.items.filter(item => item.state === 'running');
    const waiting = model.items.filter(item => item.state === 'approval' || item.state === 'input');
    const finished = model.items.filter(item => item.state === 'done' || item.state === 'error');
    // An event that happened while the island was hidden is marked seen without expanding later.
    const alerting = (key: string) => { const fresh = !seen.current.has(key); seen.current.add(key); return fresh && model.alert && model.visible; };
    const desired: Desired[] = [];
    if (running.length) {
      const split = waiting.length > 0 || finished.length > 0;
      desired.push({ id: 'running', alert: false, sig: JSON.stringify(['run', model.zh, split, running.map(item => [item.key, item.title, item.since, item.provider])]),
        options: { id: 'running', label: words.runningLabel(running.length), priority: 1, onPress: press('running'), ...runningContent(running, split, words, actions) } });
    }
    if (waiting.length) {
      const fresh = waiting.map(item => alerting(`${item.key}:${item.state}:${item.since}`)).some(Boolean);
      desired.push({ id: 'waiting', alert: fresh, sig: JSON.stringify(['wait', model.zh, waiting.map(item => [item.key, item.state, item.since, item.title, !!item.approval])]),
        options: { id: 'waiting', label: words.waitingMany(waiting.length), priority: 3, onPress: press('waiting'), ...waitingContent(waiting, words, model.zh, actions) } });
    }
    for (const item of finished) {
      const id = `finished:${item.key}:${item.since}`;
      desired.push({ id, alert: !shown.current.has(id) && alerting(id), sig: JSON.stringify([item.state, model.zh, item.result ?? '']),
        options: { id, group: 'finished', label: words.finishedTitle(item), priority: 2, onPress: press(id), ...finishedContent(item, words, actions) } });
    }
    for (const want of desired) {
      const previous = shown.current.get(want.id);
      if (want.alert) window.clearTimeout(leave.timer);
      if (previous === undefined) island.start({ ...want.options, alert: want.alert });
      else if (previous !== want.sig) {
        const { compact, minimal, expanded, label, priority, onPress } = want.options;
        island.update(want.id, { compact, minimal, expanded, label, priority, onPress, alert: want.alert || undefined });
      }
      shown.current.set(want.id, want.sig);
    }
    for (const id of [...shown.current.keys()]) if (!desired.some(want => want.id === id)) { island.end(id); shown.current.delete(id); }
  }, [model, island]);
  return null;
}

/** The island's place in its window, shown while main says so and something is on it. */
function Stage({ visible, zh }: { visible: boolean; zh: boolean }) {
  const island = useIsland();
  const on = visible && island.activities.length > 0;
  const expanded = island.presentation === 'expanded';
  const state = useRef({ on, expanded, over: false });
  state.current.on = on; state.current.expanded = expanded;
  const drag = useRef<{ x: number; moved: boolean }>(undefined);

  // Clicks land on the island only: over anything else the window lets them through to the app underneath.
  useEffect(() => {
    const report = (over: boolean) => {
      if (over === state.current.over) return;
      state.current.over = over;
      bridge?.setInteractive(over);
      window.clearTimeout(leave.timer);
      if (!over && state.current.expanded) leave.timer = window.setTimeout(() => { if (state.current.expanded && !state.current.over) island.collapse(); }, 1400);
    };
    const at = (x: number, y: number) => {
      if (drag.current) return;
      const target = state.current.on ? document.elementFromPoint(x, y) : null;
      report(!!target && target !== document.documentElement && target !== document.body && target.id !== 'island-root');
    };
    const move = (event: MouseEvent) => at(event.clientX, event.clientY);
    // Leaving the window is decided by main, not by a `mouseout`: Windows hands the page a stale "mouse left" the moment
    // the window starts catching clicks, which would let the click through again (desktop/src/taskIsland.ts `interactive`).
    // While clicks pass through, the page hears no mouse at all: main reports where the pointer is over the window.
    window.addEventListener('mousemove', move);
    const unsubscribe = bridge?.onPointerLeft(() => { if (!drag.current) report(false); });
    const unsubscribePointer = bridge?.onPointer(point => at(point.x, point.y));
    return () => { window.removeEventListener('mousemove', move); unsubscribe?.(); unsubscribePointer?.(); };
  }, [island]);

  useEffect(() => {
    if (on) return;
    // Hidden: back to compact for next time, and stop catching clicks.
    if (island.presentation === 'expanded') island.collapse();
    state.current.over = false; bridge?.setInteractive(false);
  }, [on, island]);

  // Drag sideways along the top edge; main moves the window and remembers where it was left.
  useEffect(() => {
    const moved = (event: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      const dx = event.screenX - current.x;
      if (!current.moved && Math.abs(dx) < 5) return;
      if (!current.moved) { current.moved = true; bridge?.drag('start', 0); }
      dragged.at = Date.now();
      bridge?.drag('move', dx);
    };
    const up = (event: PointerEvent) => {
      const current = drag.current;
      drag.current = undefined;
      if (current?.moved) { dragged.at = Date.now(); bridge?.drag('end', event.screenX - current.x); }
    };
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', moved); window.removeEventListener('pointerup', up); };
  }, []);

  return <div className={`ti-stage${on ? ' is-on' : ''}`} onPointerDownCapture={event => { if (!expanded) drag.current = { x: event.screenX, moved: false }; }}>
    <Island placement="container" label={islandWords(zh).region} keyline="on" />
  </div>;
}
