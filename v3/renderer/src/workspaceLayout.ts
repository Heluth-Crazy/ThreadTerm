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
