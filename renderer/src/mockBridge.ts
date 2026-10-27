/// <reference types="vite/client" />
/* Browser demo bridge: the real `window.threadterm` comes from the Electron preload. When the dev server
   is opened in a plain browser there is no runtime behind it, so this module installs a read-mostly stub
   with demo data — enough for the workbench to render. Mutations reject; nothing here is the real runtime. */
import type { Method, RequestParams, RequestResult, Snapshot, ThreadTermBridge } from "@threadterm/protocol";

const now = () => new Date().toISOString();

function demoSnapshot(): Snapshot {
  return {
    epoch: "browser-demo",
    revision: 1,
    projects: [
      { id: "demo-project", name: "ThreadTerm 演示项目", path: "D:/project/demo", createdAt: now() },
    ],
    sessions: [
      { id: "demo-chat", projectId: "demo-project", title: "示例对话（浏览器演示）", provider: "kimi", mode: "chat", status: "idle", createdAt: now(), updatedAt: now() },
      { id: "demo-terminal", projectId: "demo-project", title: "示例终端", provider: "shell", mode: "terminal", status: "running", createdAt: now(), updatedAt: now(), cols: 80, rows: 24 },
    ],
    settings: { revision: 0, theme: "dark", language: "zh-CN" },
    workspaces: [],
    presets: [],
    inbox: [],
    providers: [
      { id: "kimi", name: "Kimi", installed: true, terminal: true, chat: true, history: true, resume: true, auth: "authenticated" },
      { id: "codex", name: "Codex", installed: true, terminal: true, chat: true, history: true, resume: true, auth: "unknown" },
      { id: "claude", name: "Claude", installed: false, terminal: true, chat: true, history: true, resume: true, reason: "浏览器演示模式，未连接真实运行时" },
    ],
  };
}

function respond(method: Method): unknown {
  switch (method) {
    case "runtime.snapshot":
      return demoSnapshot();
    case "catalog.visibility.list":
    case "worktree.list":
    case "draft.list":
    case "review.list":
    case "agentReview.list":
    case "history.list":
    case "device.list":
      return [];
    case "provider.list":
      return demoSnapshot().providers;
    case "project.catalog.list":
      return demoSnapshot().projects.map((project) => ({ ...project, revision: 1, pinned: false, sortOrder: 0, git: { available: false } }));
    case "plugin.list":
      return { directory: "", plugins: [] };
    case "preset.list":
    case "quickLaunch.list":
      return [];
    case "quickLaunch.setup.read":
      return { revision: 0, commandIds: [] };
    case "runtime.health":
      return { ok: true, mock: true };
    case "inbox.read":
      return { revision: 0 };
    case "chat.snapshot":
      return { items: [], revision: 0, hasEarlier: false };
    case "chat.queue.read":
      return { items: [], revision: 0 };
    case "chat.draft.read":
      return { text: "", revision: 0 };
    case "chat.options":
      return { options: [], commands: [], loadState: "ready" };
    default:
      throw new Error(`浏览器演示模式不支持该操作: ${method}`);
  }
}

export function installMockBridge(): void {
  const bridge: ThreadTermBridge = {
    platform: "browser",
    request: (async <M extends Method>(method: M, _params: RequestParams<M>) => respond(method) as RequestResult<M>) as ThreadTermBridge["request"],
    onEvent: () => () => {},
    onDesktopNavigate: () => () => {},
    windowState: () => Promise.resolve({ maximized: false }),
    onWindowState: () => () => {},
    subscribeOutput: () => Promise.resolve(() => {}),
    chooseDirectory: () => Promise.resolve(null),
    chooseSavePath: () => Promise.resolve(null),
    exportFile: () => Promise.resolve(null),
    activateDataRelocation: () => Promise.resolve({ activated: false }),
    windowAction: () => Promise.resolve(),
    openWindow: () => Promise.resolve(),
    openExternal: () => Promise.resolve(),
    openPluginsFolder: () => Promise.resolve(),
    pickPageTarget: () => Promise.resolve(null),
    cancelPagePick: () => Promise.resolve(),
    markPageTarget: () => Promise.resolve(false),
    readPageShot: () => Promise.resolve(undefined),
    deletePageShots: () => Promise.resolve(),
    onPageContextMenu: () => () => {},
    openDirectory: () => Promise.resolve(),
    desktopPreferences: () => Promise.resolve({ shortcuts: {} }),
    testNotification: () => Promise.resolve({ sent: false, reason: "浏览器演示模式" }),
    exportDiagnostics: () => Promise.resolve(null),
    scheduleElectronCacheCleanup: () => Promise.resolve({ scheduled: false, available: false }),
  };
  window.threadterm = bridge;
  console.info("[threadterm] 浏览器演示模式：已注入 mock bridge，未连接真实运行时。");
}

if (import.meta.env.DEV && typeof window !== "undefined" && !window.threadterm) {
  installMockBridge();
}
