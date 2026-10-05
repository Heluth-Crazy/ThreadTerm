/* Launch screen choreography (from prototypes/app-loading), kept free of the DOM so the timing rules are testable.
   The prototype is a fixed 6 s study; the app version is tied to the real start-up instead:
   - the intro (agents float in, converge into the core, the wordmark rises) runs on its own clock up to SPLASH_GATE;
   - it HOLDS at the gate until the app has loaded, so it can never finish while the app is still loading;
   - once loaded it plays the short "ready" finale (core lights up) and fades straight into the app;
   - a load that completes before the gate speeds the rest of the intro up rather than making the user sit through it.
   Timeline values are milliseconds at normal speed. */

export const SPLASH_GATE = 2200;
/** Playback rate of the remaining intro once the app is ready before the gate. */
export const SPLASH_FAST_RATE = 1.6;
const FAST_RAMP_MS = 220;
/** Timeline ms from the gate (app ready) to the start of the exit fade. */
export const SPLASH_FINALE = 420;
export const SPLASH_EXIT = 320;
const FAILED_EXIT = 240;
/** A stalled frame (a long task during start-up) advances the clock by at most this much. */
const MAX_FRAME_MS = 100;

export const APPEAR_AT = 60;
const APPEAR_STAGGER = 0.35;
export const APPEAR_MS = 520;
export const CONVERGE_AT = 650;
export const CONVERGE_MS = 1050;
const CORE_INTRO_MS = 600;
export const TITLE_AT = 1450;
export const TITLE_MS = 600;
export const SUBLINE_AT = 1680;
export const SUBLINE_MS = 500;
const STATUS_AT = 200;
const STATUS_MS = 400;
const GATHERING_AT = 1000;
const PROGRESS_AT = 260;
const PROGRESS_MS = 400;
/** Progress shown on reaching the gate; while holding it creeps toward PROGRESS_HELD_MAX, never to the end. */
const PROGRESS_AT_GATE = 0.78;
const PROGRESS_HELD_MAX = 0.94;
const HOLD_EASE_MS = 700;
const BREATH_MS = 2400;
/** Waiting this long at the gate switches the status to the step that is actually pending (the runtime). */
export const CONNECTING_AFTER_MS = 600;

export type SplashAgent = {
  id: string;
  name: string;
  /** Resting direction (degrees) and distance (share of the ring) around the core. */
  angle: number;
  radius: number;
  /** Stagger (ms) of this agent's entrance and convergence. */
  delay: number;
  color: readonly [number, number, number];
  spin: number;
};
export const SPLASH_AGENTS: readonly SplashAgent[] = [
  { id: "claude", name: "Claude Code", angle: -151, radius: 0.9, delay: 0, color: [217, 119, 87], spin: -9 },
  { id: "codex", name: "Codex", angle: -70, radius: 0.86, delay: 110, color: [139, 154, 255], spin: 8 },
  { id: "gemini", name: "Gemini", angle: 2, radius: 1, delay: 210, color: [81, 157, 255], spin: -7 },
  { id: "kimi", name: "Kimi", angle: 147, radius: 0.83, delay: 310, color: [53, 135, 255], spin: 10 },
  { id: "grok", name: "Grok", angle: -110, radius: 0.94, delay: 390, color: [149, 153, 177], spin: -8 },
  // Curves upward (negative spin), unlike the prototype: bowing downward it crossed the wordmark as that rose.
  { id: "opencode", name: "OpenCode", angle: 45, radius: 0.86, delay: 480, color: [152, 158, 181], spin: -7 },
];

export type SplashOutcome = "ready" | "failed";
export type SplashPhase = "intro" | "hold" | "finale" | "exit" | "done";
export type SplashStatus = "preparing" | "gathering" | "connecting" | "ready" | "failed";
export type SplashClock = {
  /** Timeline ms. Never passes SPLASH_GATE before the outcome is known. */
  t: number;
  /** Real ms spent holding at the gate. */
  held: number;
  outcome?: SplashOutcome;
  /** Real ms since the outcome arrived. */
  since: number;
  /** Exit fade progress, 0..1; 1 means the launch screen is gone. */
  exit: number;
  /** prefers-reduced-motion: a still composition that only fades out. */
  reduced: boolean;
};

export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export const smooth = (value: number) => { const v = clamp(value); return v * v * (3 - 2 * v); };
const easeOut = (value: number) => 1 - Math.pow(1 - clamp(value), 3);
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

export function startClock(reduced = false): SplashClock {
  return { t: reduced ? SPLASH_GATE : 0, held: 0, since: 0, exit: 0, reduced };
}

/** The first outcome wins; a later refresh error or recovery does not restart the launch screen. */
export function settleClock(clock: SplashClock, outcome: SplashOutcome): SplashClock {
  return clock.outcome ? clock : { ...clock, outcome, since: 0 };
}

export function splashPhase(clock: SplashClock): SplashPhase {
  if (clock.exit >= 1) return "done";
  if (clock.exit > 0) return "exit";
  if (!clock.outcome) return clock.t >= SPLASH_GATE ? "hold" : "intro";
  return clock.outcome === "ready" && clock.t >= SPLASH_GATE ? "finale" : "intro";
}

export function advanceClock(clock: SplashClock, elapsed: number): SplashClock {
  const dt = clamp(elapsed, 0, MAX_FRAME_MS);
  const next: SplashClock = { ...clock, since: clock.outcome ? clock.since + dt : 0 };
  if (next.outcome === "failed") {
    // No celebration for a failed start: the error screen behind is the interface, reveal it promptly.
    next.t = Math.min(SPLASH_GATE, next.t + dt);
    next.exit = Math.min(1, next.exit + dt / FAILED_EXIT);
    return next;
  }
  if (next.exit > 0) {
    next.t += dt; // the finale (ring, sheen) keeps moving while the screen fades
    next.exit = Math.min(1, next.exit + dt / SPLASH_EXIT);
    return next;
  }
  if (!next.outcome) {
    if (next.t >= SPLASH_GATE) next.held += dt;
    next.t = Math.min(SPLASH_GATE, next.t + dt);
    return next;
  }
  let budget = dt;
  if (next.t < SPLASH_GATE) {
    const rate = 1 + (SPLASH_FAST_RATE - 1) * clamp(next.since / FAST_RAMP_MS);
    const step = Math.min(SPLASH_GATE - next.t, budget * rate);
    next.t += step;
    budget -= step / rate;
  }
  const end = SPLASH_GATE + (next.reduced ? 0 : SPLASH_FINALE);
  if (next.t < end) {
    const step = Math.min(end - next.t, budget);
    next.t += step;
    budget -= step;
  }
  if (next.t >= end && budget > 0) next.exit = Math.min(1, budget / SPLASH_EXIT);
  return next;
}

export type SplashSize = { width: number; height: number };
export type AgentFrame = { u: number; opacity: number; fade: number; x: number; y: number; rotate: number; scale: number; blur: number; label: number };
export type SplashFrame = {
  phase: SplashPhase;
  status: SplashStatus;
  core: { opacity: number; scale: number };
  halo: { opacity: number; scale: number };
  ring: { opacity: number; scale: number };
  /** The core's light sweep plays once, at the start of the finale. */
  lit: boolean;
  title: number;
  subline: number;
  statusOpacity: number;
  progress: { opacity: number; fill: number };
  agents: AgentFrame[];
  /** Opacity multiplier of the suspended dust. */
  dust: number;
  exit: number;
};

/** Offset of an agent from the core at convergence progress u (0 resting, 1 absorbed); `ambient` drives the drift. */
export function agentOffset(agent: SplashAgent, u: number, ambient: number, size: SplashSize): { x: number; y: number } {
  const angle = agent.angle * Math.PI / 180;
  const rx = Math.min(size.width * 0.32, 380) * agent.radius, ry = Math.min(size.height * 0.27, 215) * agent.radius;
  const p = smooth(u), q = p * p;
  // A gentle tangential curve: velocity grows toward the core instead of snapping in on a straight line.
  const curve = Math.sin(p * Math.PI) * (0.18 * rx) * Math.sign(agent.spin);
  const driftX = Math.sin(ambient / 950 + agent.delay * 0.0065) * 5, driftY = Math.cos(ambient / 1100 + angle) * 4;
  return {
    x: Math.cos(angle) * rx * (1 - q) - Math.sin(angle) * curve + driftX * (1 - p),
    y: Math.sin(angle) * ry * (1 - q) + Math.cos(angle) * curve + driftY * (1 - p),
  };
}

export function splashFrame(clock: SplashClock, ambient: number, size: SplashSize): SplashFrame {
  const { t, reduced } = clock;
  const finale = clock.outcome === "ready" ? Math.max(0, t - SPLASH_GATE) : 0;
  const hold = reduced ? 0 : smooth(clock.held / HOLD_EASE_MS) * (1 - smooth(finale / 300));
  const breath = hold * (0.5 - 0.5 * Math.cos(ambient * 2 * Math.PI / BREATH_MS));
  const agents = SPLASH_AGENTS.map((agent): AgentFrame => {
    const appear = easeOut((t - APPEAR_AT - agent.delay * APPEAR_STAGGER) / APPEAR_MS);
    const u = clamp((t - CONVERGE_AT - agent.delay) / CONVERGE_MS);
    const fade = 1 - smooth((u - 0.77) / 0.23);
    const offset = agentOffset(agent, u, ambient, size), spread = 1 + (1 - appear) * 0.16;
    return {
      u, fade, opacity: reduced ? 0 : appear * fade,
      x: offset.x * spread, y: offset.y * spread,
      rotate: agent.spin * (1 - smooth(u)),
      scale: lerp(1.035, 0.18, Math.pow(u, 2.3)),
      blur: (1 - appear) * 4 + smooth((u - 0.76) / 0.24) * 2.5,
      label: 1 - smooth(u / 0.33),
    };
  });
  // Each agent sends a soft pulse through the core as it is absorbed.
  const energy = reduced ? 0 : agents.reduce((sum, agent) => sum + Math.exp(-Math.pow((agent.u - 0.88) / 0.12, 2)) * 0.15, 0);
  const intro = easeOut(t / CORE_INTRO_MS), completion = reduced ? 0 : smooth(finale / 380);
  const ring = reduced ? 0 : smooth((finale - 40) / 140) * (1 - smooth((finale - 180) / 520));
  const waiting = PROGRESS_AT_GATE * clamp(t / SPLASH_GATE) + (PROGRESS_HELD_MAX - PROGRESS_AT_GATE) * (1 - Math.exp(-clock.held / 3500));
  const status: SplashStatus = clock.outcome === "failed" ? "failed"
    : clock.outcome === "ready" && t >= SPLASH_GATE ? "ready"
      : clock.held >= CONNECTING_AFTER_MS ? "connecting"
        : t >= GATHERING_AT ? "gathering" : "preparing";
  return {
    phase: splashPhase(clock),
    status,
    core: { opacity: clamp(0.28 + 0.36 * intro + 0.36 * completion + 0.05 * breath), scale: 0.84 + 0.16 * completion + energy * 0.045 + 0.018 * breath },
    halo: { opacity: clamp(0.22 * intro + energy * 0.6 + 0.5 * completion + 0.1 * breath), scale: 0.7 + energy * 0.25 + completion * 0.3 + 0.05 * breath },
    ring: { opacity: ring * 0.6, scale: 1 + smooth((finale - 40) / 700) * 0.5 },
    lit: !reduced && finale >= 60,
    title: easeOut((t - TITLE_AT) / TITLE_MS),
    subline: easeOut((t - SUBLINE_AT) / SUBLINE_MS),
    statusOpacity: easeOut((t - STATUS_AT) / STATUS_MS) * 0.8,
    progress: { opacity: easeOut((t - PROGRESS_AT) / PROGRESS_MS), fill: finale > 0 ? lerp(waiting, 1, easeOut(finale / 260)) : waiting },
    agents,
    dust: reduced ? 0 : 1 - smooth(finale / 500),
    exit: clock.exit,
  };
}
