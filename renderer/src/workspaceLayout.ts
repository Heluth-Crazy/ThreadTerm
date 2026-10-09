import type { ContentRef, PaneLayout } from "@threadterm/protocol";
export const paneCount = (layout: PaneLayout): number =>
  layout.kind === "pane"
    ? 1
    : paneCount(layout.first) + paneCount(layout.second);
export const closePane = (
  layout: PaneLayout,
  id: string,
): PaneLayout | undefined => {
  if (layout.kind === "pane") return layout.id === id ? undefined : layout;
  const first = closePane(layout.first, id),
    second = closePane(layout.second, id);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
};
export const addPane = (layout: PaneLayout, tab: ContentRef): PaneLayout =>
  paneCount(layout) >= 4
    ? layout
    : {
        kind: "split",
        id: crypto.randomUUID(),
        direction: "horizontal",
        ratio: 0.5,
        first: layout,
        second: {
          kind: "pane",
          id: crypto.randomUUID(),
          tabs: [tab],
          activeTabId: tab.id,
        },
      };
/** Split only the selected leaf; the new second leaf starts empty. */
export const splitPane = (
  layout: PaneLayout,
  paneId: string,
  direction: "horizontal" | "vertical",
  newPaneId: string = crypto.randomUUID(),
): PaneLayout => {
  if (paneCount(layout) >= 4) return layout;
  const visit = (node: PaneLayout): PaneLayout => {
    if (node.kind === "pane")
      return node.id === paneId
        ? {
            kind: "split",
            id: crypto.randomUUID(),
            direction,
            ratio: 0.5,
            first: node,
            second: { kind: "pane", id: newPaneId, tabs: [], activeTabId: null },
          }
        : node;
    const first = visit(node.first), second = visit(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return visit(layout);
};
export const paneIdsIn = (layout: PaneLayout): string[] =>
  layout.kind === "pane"
    ? [layout.id]
    : [...paneIdsIn(layout.first), ...paneIdsIn(layout.second)];
export const sessionIdsIn = (layout: PaneLayout): string[] =>
  layout.kind === "pane"
    ? layout.tabs.flatMap((tab) => (tab.kind === "session" ? [tab.sessionId] : []))
    : [...sessionIdsIn(layout.first), ...sessionIdsIn(layout.second)];
/** Remove session tabs that are no longer visible, then reveal the routed
 * session in its existing pane or add it to the first pane. */
export const reconcileSessionLayout = (
  layout: PaneLayout,
  visibleSessionIds: ReadonlySet<string>,
  routedSessionId: string,
): PaneLayout => {
  const visible = new Set(visibleSessionIds);
  visible.add(routedSessionId);
  const prune = (node: PaneLayout): PaneLayout => {
    if (node.kind === "pane") {
      const tabs = node.tabs.filter(
        (tab) => tab.kind !== "session" || visible.has(tab.sessionId),
      );
      const activeTabId = tabs.some((tab) => tab.id === node.activeTabId)
        ? node.activeTabId
        : (tabs[0]?.id ?? null);
      return tabs.length === node.tabs.length && activeTabId === node.activeTabId
        ? node
        : { ...node, tabs, activeTabId };
    }
    const first = prune(node.first), second = prune(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  const focus = (node: PaneLayout): { layout: PaneLayout; found: boolean } => {
    if (node.kind === "pane") {
      const tab = node.tabs.find(
        (item) => item.kind === "session" && item.sessionId === routedSessionId,
      );
      return tab
        ? { layout: node.activeTabId === tab.id ? node : { ...node, activeTabId: tab.id }, found: true }
        : { layout: node, found: false };
    }
    const first = focus(node.first);
    if (first.found)
      return {
        layout: first.layout === node.first ? node : { ...node, first: first.layout },
        found: true,
      };
    const second = focus(node.second);
    return {
      layout: second.layout === node.second ? node : { ...node, second: second.layout },
      found: second.found,
    };
  };
  const pruned = prune(layout);
  const focused = focus(pruned);
  if (focused.found) return focused.layout;
  const tab: ContentRef = {
    id: `session-${routedSessionId}`,
    kind: "session",
    sessionId: routedSessionId,
  };
  const addToFirstPane = (node: PaneLayout): PaneLayout =>
    node.kind === "pane"
      ? { ...node, tabs: [...node.tabs, tab], activeTabId: tab.id }
      : { ...node, first: addToFirstPane(node.first) };
  return addToFirstPane(pruned);
};
export const addTabToPane = (
  layout: PaneLayout,
  paneId: string,
  tab: ContentRef,
): PaneLayout => {
  const visit = (node: PaneLayout): PaneLayout => {
    if (node.kind === "pane")
      return node.id !== paneId || node.tabs.some((item) => item.id === tab.id)
        ? node
        : { ...node, tabs: [...node.tabs, tab], activeTabId: tab.id };
    const first = visit(node.first), second = visit(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return visit(layout);
};
/**
 * Put a runtime-presented page into the shared browser leaf.  Web tabs are
 * deliberately independent workspace content: their runtime provenance lives
 * outside the saved layout, so same-URL pages from separate sessions remain
 * separate tabs.
 *
 * A browser leaf is reused even at the pane cap.  When none exists, split the
 * owning chat leaf so the chat and page stay visible together.  The caller can
 * report `layout_unavailable` without disturbing an existing editor when that
 * would exceed the four-pane contract.
 */
export const placeWebTabBesideSession = (
  layout: PaneLayout,
  sessionId: string,
  tab: Extract<ContentRef, { kind: "web" }>,
): { layout: PaneLayout; paneId?: string; status: "placed" | "layout_unavailable" } => {
  const tabs = (node: PaneLayout): { paneId: string; tab: ContentRef }[] =>
    node.kind === "pane"
      ? node.tabs.map((item) => ({ paneId: node.id, tab: item }))
      : [...tabs(node.first), ...tabs(node.second)];
  const leaf = (node: PaneLayout, paneId: string): Extract<PaneLayout,{kind:'pane'}>|undefined =>
    node.kind === 'pane' ? (node.id === paneId ? node : undefined) : leaf(node.first,paneId) ?? leaf(node.second,paneId);
  // A page may share an ordinary work pane, but it is not a reusable browser
  // surface: activating its owner chat would hide the page.  Only a leaf with
  // no Chat tabs can keep both surfaces mounted side by side.
  const existingBrowser = tabs(layout).find((item) => item.tab.kind === "web" && !leaf(layout,item.paneId)?.tabs.some(candidate=>candidate.kind==='session'))?.paneId;
  const ownerPane = tabs(layout).find(
    (item) => item.tab.kind === "session" && item.tab.sessionId === sessionId,
  )?.paneId;
  if (existingBrowser) {
    const next=activate(addTabToPane(layout, existingBrowser, tab),existingBrowser,tab.id);
    const owner=ownerPane&&tabs(next).find(item=>item.paneId===ownerPane&&item.tab.kind==='session'&&item.tab.sessionId===sessionId)?.tab.id;
    return { layout: owner ? activate(next,ownerPane!,owner) : next, paneId: existingBrowser, status: "placed" };
  }

  if (!ownerPane || paneCount(layout) >= 4)
    return { layout, status: "layout_unavailable" };

  const browserPaneId = crypto.randomUUID();
  const split = splitPane(layout, ownerPane, "horizontal", browserPaneId);
  return {
    layout: addTabToPane(split, browserPaneId, tab),
    paneId: browserPaneId,
    status: "placed",
  };
};
/** Select an already-persisted runtime page and its owning Chat without
 * changing the flat persisted layout shape. */
export const selectWebTabBesideSession=(layout:PaneLayout,sessionId:string,tabId:string):PaneLayout=>{
 const locate=(node:PaneLayout):{paneId:string;tab:ContentRef}|undefined=>node.kind==='pane'
  ? node.tabs.find(tab=>tab.id===tabId)?{paneId:node.id,tab:node.tabs.find(tab=>tab.id===tabId)!}:undefined
  :locate(node.first)??locate(node.second);
 const owner=(node:PaneLayout):{paneId:string;tab:ContentRef}|undefined=>node.kind==='pane'
  ? node.tabs.find(tab=>tab.kind==='session'&&tab.sessionId===sessionId)?{paneId:node.id,tab:node.tabs.find(tab=>tab.kind==='session'&&tab.sessionId===sessionId)!}:undefined
  :owner(node.first)??owner(node.second);
 const page=locate(layout),chat=owner(layout);
 if(!page||page.tab.kind!=='web')return layout;
 const pageActive=activate(layout,page.paneId,tabId);
 return chat&&chat.paneId!==page.paneId?activate(pageActive,chat.paneId,chat.tab.id):pageActive;
};
export const activate = (
  layout: PaneLayout,
  paneId: string,
  tabId: string,
): PaneLayout =>
  layout.kind === "pane"
    ? layout.id === paneId
      ? { ...layout, activeTabId: tabId }
      : layout
    : {
        ...layout,
        first: activate(layout.first, paneId, tabId),
        second: activate(layout.second, paneId, tabId),
      };
export const resizeSplit = (
  layout: PaneLayout,
  id: string,
  ratio: number,
): PaneLayout =>
  layout.kind === "pane"
    ? layout
    : {
        ...layout,
        ratio:
          layout.id === id ? Math.max(0.1, Math.min(0.9, ratio)) : layout.ratio,
        first: resizeSplit(layout.first, id, ratio),
        second: resizeSplit(layout.second, id, ratio),
      };
export const reorderTab = (
  layout: PaneLayout,
  paneId: string,
  from: number,
  to: number,
): PaneLayout =>
  layout.kind === "pane"
    ? layout.id !== paneId
      ? layout
      : {
          ...layout,
          tabs: (() => {
            const tabs = [...layout.tabs];
            const [tab] = tabs.splice(from, 1);
            if (tab)
              tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab);
            return tabs;
          })(),
        }
    : {
        ...layout,
        first: reorderTab(layout.first, paneId, from, to),
        second: reorderTab(layout.second, paneId, from, to),
      };
export const closeTab = (
  layout: PaneLayout,
  paneId: string,
  tabId: string,
): PaneLayout =>
  layout.kind === "pane"
    ? layout.id !== paneId
      ? layout
      : {
          ...layout,
          tabs: layout.tabs.filter((tab) => tab.id !== tabId),
          activeTabId:
            layout.activeTabId === tabId
              ? (layout.tabs.find((tab) => tab.id !== tabId)?.id ?? null)
              : layout.activeTabId,
        }
    : {
        ...layout,
        first: closeTab(layout.first, paneId, tabId),
        second: closeTab(layout.second, paneId, tabId),
      };
/**
 * A session opens as just its sessions (user decision 2026-09-28): drop every non-session tab that `keep`
 * rejects (callers keep file tabs with unsaved edits), prefer a session tab as each pane's active tab and
 * collapse panes left empty. Session tabs and the split geometry between them are kept. Never returns an
 * empty layout: if every pane empties, the first pane stays as an empty leaf for the routed session.
 */
export const sessionOnlyLayout = (
  layout: PaneLayout,
  keep: (tab: Exclude<ContentRef, { kind: "session" }>) => boolean,
): PaneLayout => {
  const emptied: string[] = [];
  const prune = (node: PaneLayout): PaneLayout => {
    if (node.kind === "pane") {
      const tabs = node.tabs.filter((tab) => tab.kind === "session" || keep(tab));
      if (tabs.length === node.tabs.length) return node;
      if (!tabs.length) emptied.push(node.id);
      const activeTabId = tabs.some((tab) => tab.id === node.activeTabId)
        ? node.activeTabId
        : (tabs.find((tab) => tab.kind === "session")?.id ?? tabs[0]?.id ?? null);
      return { ...node, tabs, activeTabId };
    }
    const first = prune(node.first), second = prune(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  let next = prune(layout);
  for (const id of emptied) {
    const collapsed = closePane(next, id);
    if (!collapsed) return { kind: "pane", id, tabs: [], activeTabId: null };
    next = collapsed;
  }
  return next;
};
