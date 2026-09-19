const selectorGroups = {
  // The prototype's .app-stage is its application interior.  Do not use the
  // decorative desktop, faux frame, wallpaper, clock, or outer margins.
  application: [".app-stage", ".app-shell", ".shell", "#app", "#root"],
  chrome: [".app-chrome", ".titlebar"],
  sidebar: [".sidebar"],
  main: ["main", ".content", ".page"],
  rightRail: [".usage-panel", ".t-rail", ".history-rail", ".session-history-rail"],
  metrics: [".metric-strip", ".metrics", ".metric-grid"],
  settings: [".settings-panel"],
  settingsNavigation: [".settings-layout nav"],
  dialog: [".dialog:not(.settings-panel)"],
  terminals: [".t-grid", ".terminals", ".session-list", ".session-card"],
  workspaceHeader: [".ws-top"],
  workspaceTabs: [".ws-tabrow"],
  workspaceSessions: [".ws-strip"],
  presets: [".preset-grid"],
};

export function metricScript() {
  return ({ selectors }) => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const box = (node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100 };
    };
    const firstVisible = (choices) => choices.map((choice) => document.querySelector(choice)).find((node) => node && visible(node));
    const styleOf = (node) => {
      if (!node) return null;
      const style = getComputedStyle(node);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        borderRadius: style.borderRadius,
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        gap: style.gap,
        lineHeight: style.lineHeight,
        padding: style.padding,
      };
    };
    const regions = Object.fromEntries(Object.entries(selectors).map(([name, choices]) => {
      const node = firstVisible(choices);
      return [name, node ? { selector: choices.find((choice) => document.querySelector(choice) === node), box: box(node), style: styleOf(node) } : null];
    }));
    const typeNodes = [...document.querySelectorAll("h1,h2,h3,button,input,textarea,.metric strong,.metric-value")]
      .filter(visible)
      .slice(0, 24)
      .map((node) => ({ tag: node.tagName, text: (node.textContent || node.getAttribute("aria-label") || "").trim().slice(0, 80), box: box(node), style: styleOf(node) }));
    const root = regions.application?.box;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      root,
      regions,
      typography: typeNodes,
      overflow: { horizontal: document.documentElement.scrollWidth > innerWidth + 1, vertical: document.documentElement.scrollHeight > innerHeight + 1 },
    };
  };
}

export { selectorGroups };

export function compareMetrics(reference, production) {
  const deviations = [];
  for (const [name, expected] of Object.entries(reference.regions)) {
    if (name === "chrome") continue; // native/faux chrome has a separate QA track
    const actual = production.regions[name];
    if (!expected && !actual) continue;
    if (!expected) { deviations.push({ region: name, kind: "unexpected-region", actual }); continue; }
    if (!actual) { deviations.push({ region: name, kind: "missing-region", expected }); continue; }
    for (const field of ["x", "y", "width", "height"]) {
      const delta = Math.round((actual.box[field] - expected.box[field]) * 100) / 100;
      if (Math.abs(delta) > 1) deviations.push({ region: name, kind: "bounds", field, expected: expected.box[field], actual: actual.box[field], delta });
    }
    for (const field of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "color", "backgroundColor", "borderColor", "borderRadius", "gap", "padding"]) {
      if (actual.style[field] !== expected.style[field]) deviations.push({ region: name, kind: "token", field, expected: expected.style[field], actual: actual.style[field] });
    }
  }
  for (const side of ["reference", "production"]) {
    const metrics = side === "reference" ? reference : production;
    if (metrics.overflow.horizontal) deviations.push({ region: "document", kind: "horizontal-overflow", side });
  }
  return deviations;
}
