/* Drives the launch screen that index.html paints before the app bundle runs (markup there, styles in
   bootSplash.css, choreography in bootSplashTimeline.ts). Only the main window has it: index.html's pre-paint
   script removes it from floating and session windows, which makes everything here a no-op. */
import { agentIconMarkup } from "./components/PrototypeIcon";
import {
  SPLASH_AGENTS,
  SPLASH_EXIT,
  SPLASH_FINALE,
  SPLASH_GATE,
  advanceClock,
  agentOffset,
  clamp,
  settleClock,
  splashFrame,
  startClock,
  type SplashClock,
  type SplashOutcome,
  type SplashSize,
  type SplashStatus,
} from "./bootSplashTimeline";

/** index.html's pre-paint script reads this key; keep the two in step. */
const APPEARANCE_KEY = "threadterm.v3.boot-appearance";

export type BootAppearance = {
  theme: "light" | "dark" | "system";
  tokens?: { background: string; surface: string; text: string; muted: string; border: string };
  locale: "en" | "zh-CN";
};

const STATUS_TEXT: Record<"en" | "zh-CN", Record<SplashStatus, string>> = {
  "zh-CN": { preparing: "正在准备工作台", gathering: "正在汇聚你的 AI 工作空间", connecting: "正在连接本地运行时", ready: "工作台已就绪", failed: "无法连接本地运行时" },
  en: { preparing: "Preparing your workspace", gathering: "Bringing your agents together", connecting: "Connecting to the local runtime", ready: "Workspace ready", failed: "Can't reach the local runtime" },
};

let savedAppearance: string | undefined;
/** Remembers the theme and language the app resolved, so the next launch screen paints in them from its first frame. */
export function rememberBootAppearance(appearance: BootAppearance): void {
  const { theme, locale, tokens } = appearance;
  const value = JSON.stringify(tokens ? { theme, locale, tokens: { background: tokens.background, surface: tokens.surface, text: tokens.text, muted: tokens.muted, border: tokens.border } } : { theme, locale });
  if (value === savedAppearance) return;
  savedAppearance = value;
  try { localStorage.setItem(APPEARANCE_KEY, value); } catch { /* The next launch screen falls back to the system theme. */ }
}

/** The app calls this once its first snapshot (or a runtime error) is on screen; the launch screen then finishes
 * and hands over. Until then it holds, so it can never finish while the app is still loading. */
export function settleBootSplash(outcome: SplashOutcome): void {
  controller?.settle(outcome);
}

const splash = typeof document === "undefined" ? null : document.getElementById("boot-splash");
const controller = splash ? startBootSplash(splash) : undefined;

function startBootSplash(root: HTMLElement): { settle: (outcome: SplashOutcome) => void } {
  const part = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const stage = part(".bs-stage"), core = part(".bs-core"), halo = part(".bs-halo"), ring = part(".bs-ring");
  const title = part(".bs-wordmark"), subline = part(".bs-subline"), status = part(".bs-status"), statusText = part(".bs-status-text");
  const progress = part(".bs-progress"), progressFill = part(".bs-progress i"), canvas = part<HTMLCanvasElement>(".bs-dust");
  const context = canvas.getContext("2d");
  const locale = root.lang === "zh-CN" ? "zh-CN" : "en";
  const reduced = root.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nodes = SPLASH_AGENTS.map((agent) => {
    const node = document.createElement("div");
    node.className = "bs-agent";
    // Static brand constants and fixed names only; never user text.
    node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${agentIconMarkup(agent.id) ?? ""}</svg><span>${agent.name}</span>`;
    part(".bs-agents").append(node);
    return { node, label: node.lastElementChild as HTMLElement };
  });
  // Sparse suspended dust at fixed pseudo-random spots, as in the prototype.
  const dust = Array.from({ length: 54 }, (_, index) => ({ x: ((index * 7919) % 997) / 997, y: ((index * 3571) % 991) / 991, size: 0.45 + (index % 4) * 0.22, phase: index * 1.73 }));
  const dustColor = getComputedStyle(status).color;
  let size: SplashSize = { width: root.clientWidth, height: root.clientHeight };
  let clock: SplashClock = startClock(reduced);
  let ambient = 0, previous = 0, frame = 0, shownStatus: SplashStatus | undefined, shownPhase = "", lit = false;
  let finished = false, exitFallback: ReturnType<typeof setTimeout> | undefined;

  const resize = () => {
    size = { width: root.clientWidth, height: root.clientHeight };
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(root);
  resize();

  const render = () => {
    const view = splashFrame(clock, ambient, size);
    if (view.phase !== shownPhase) root.dataset.phase = shownPhase = view.phase;
    if (view.status !== shownStatus) statusText.textContent = STATUS_TEXT[locale][shownStatus = view.status];
    core.style.opacity = view.core.opacity.toFixed(3);
    core.style.transform = `scale(${view.core.scale.toFixed(4)})`;
    halo.style.opacity = view.halo.opacity.toFixed(3);
    halo.style.transform = `scale(${view.halo.scale.toFixed(4)})`;
    ring.style.opacity = view.ring.opacity.toFixed(3);
    ring.style.transform = `scale(${view.ring.scale.toFixed(4)})`;
    if (view.lit && !lit) { lit = true; core.classList.add("lit"); }
    title.style.opacity = view.title.toFixed(3);
    title.style.transform = `translateY(${((1 - view.title) * 8).toFixed(2)}px)`;
    subline.style.opacity = view.subline.toFixed(3);
    subline.style.transform = `translateY(${((1 - view.subline) * 6).toFixed(2)}px)`;
    status.style.opacity = view.statusOpacity.toFixed(3);
    progress.style.opacity = view.progress.opacity.toFixed(3);
    progressFill.style.transform = `scaleX(${view.progress.fill.toFixed(4)})`;
    view.agents.forEach((agent, index) => {
      const { node, label } = nodes[index];
      const visible = agent.opacity > 0.001;
      node.style.visibility = visible ? "visible" : "hidden";
      if (!visible) return;
      node.style.opacity = agent.opacity.toFixed(3);
      node.style.transform = `translate3d(${agent.x.toFixed(2)}px,${agent.y.toFixed(2)}px,0) rotate(${agent.rotate.toFixed(2)}deg) scale(${agent.scale.toFixed(4)})`;
      node.style.filter = agent.blur > 0.05 ? `blur(${agent.blur.toFixed(2)}px)` : "none";
      label.style.opacity = agent.label.toFixed(3);
    });
    root.style.opacity = (1 - view.exit * view.exit * (3 - 2 * view.exit)).toFixed(3);
    if (!reduced) stage.style.transform = view.exit > 0 ? `scale(${(1 + 0.035 * view.exit * view.exit).toFixed(4)})` : "";
    drawDust(view.dust, view.agents);
  };

  const drawDust = (amount: number, agents: ReturnType<typeof splashFrame>["agents"]) => {
    if (!context) return;
    context.clearRect(0, 0, size.width, size.height);
    if (reduced) return;
    const cx = size.width / 2, cy = size.height * 0.43;
    context.fillStyle = dustColor;
    for (const mote of dust) {
      context.globalAlpha = clamp((0.09 + Math.sin(ambient / 1100 + mote.phase) * 0.035) * amount);
      context.beginPath();
      context.arc(mote.x * size.width + Math.sin(ambient / 1500 + mote.phase) * 4, mote.y * size.height + Math.cos(ambient / 1400 + mote.phase) * 5, mote.size, 0, Math.PI * 2);
      context.fill();
    }
    // Short, soft trails follow each incoming logo and disappear as it joins the core.
    agents.forEach((agent, index) => {
      if (agent.u <= 0 || agent.u >= 1) return;
      const spec = SPLASH_AGENTS[index];
      context.fillStyle = `rgb(${spec.color.join(",")})`;
      for (let step = 1; step <= 15; step += 1) {
        const point = agentOffset(spec, clamp(agent.u - step * 0.012), ambient - step * 23, size);
        context.globalAlpha = (1 - step / 16) * 0.16 * Math.sin(agent.u * Math.PI) * agent.fade;
        context.beginPath();
        context.arc(cx + point.x, cy + point.y, (1 - step / 19) * 1.7, 0, Math.PI * 2);
        context.fill();
      }
    });
    context.globalAlpha = 1;
  };

  const tick = (now: number) => {
    const elapsed = previous ? now - previous : 0;
    previous = now;
    clock = advanceClock(clock, elapsed);
    ambient += Math.min(elapsed, 100);
    render();
    if (clock.exit >= 1) { finish(); return; }
    frame = requestAnimationFrame(tick);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    if (exitFallback !== undefined) clearTimeout(exitFallback);
    cancelAnimationFrame(frame);
    observer.disconnect();
    root.remove();
  };
  render();
  frame = requestAnimationFrame(tick);
  return { settle: (outcome) => {
    if (finished || clock.outcome) return;
    clock = settleClock(clock, outcome);
    // Occluded windows can stop rAF entirely. Allow the remaining choreography plus a
    // small margin, then remove the overlay even if no animation frame arrived.
    const remainingIntro = outcome === "ready" ? Math.max(0, SPLASH_GATE - clock.t) : 0;
    const finale = outcome === "ready" && !reduced ? SPLASH_FINALE : 0;
    exitFallback = setTimeout(finish, remainingIntro + finale + SPLASH_EXIT + 300);
  } };
}
