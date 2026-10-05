import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTING_AFTER_MS,
  CONVERGE_AT,
  CONVERGE_MS,
  SPLASH_AGENTS,
  SPLASH_EXIT,
  SPLASH_FINALE,
  SPLASH_GATE,
  SUBLINE_AT,
  SUBLINE_MS,
  TITLE_AT,
  TITLE_MS,
  advanceClock,
  settleClock,
  splashFrame,
  splashPhase,
  startClock,
  type SplashClock,
} from "./bootSplashTimeline";

const size = { width: 1418, height: 898 };
/** Runs the clock at a steady frame interval until `stop` holds; returns the real ms that passed. */
function run(clock: SplashClock, stop: (clock: SplashClock) => boolean, frame = 1000 / 60, limit = 60_000): { clock: SplashClock; elapsed: number } {
  let elapsed = 0;
  while (!stop(clock)) {
    if (elapsed > limit) throw new Error("clock never reached the stop condition");
    clock = advanceClock(clock, frame);
    elapsed += frame;
  }
  return { clock, elapsed };
}

test("the launch screen never finishes while the app is still loading, whatever the frame timing", () => {
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let clock = startClock();
  for (let index = 0; index < 20_000; index += 1) {
    clock = advanceClock(clock, random() < 0.02 ? 5000 : random() * 40);
    assert.ok(clock.t <= SPLASH_GATE, "the intro does not pass the gate");
    assert.ok(clock.exit === 0, "no exit fade before the app is ready");
    assert.notEqual(splashPhase(clock), "done");
  }
  assert.equal(splashPhase(clock), "hold");
  const frame = splashFrame(clock, 0, size);
  assert.equal(frame.status, "connecting");
  assert.ok(frame.progress.fill < 1, "the bar never completes while holding");
});

test("everything in the intro has finished by the gate, so the hold is a complete composition", () => {
  for (const agent of SPLASH_AGENTS) assert.ok(CONVERGE_AT + agent.delay + CONVERGE_MS <= SPLASH_GATE, `${agent.name} is absorbed by the gate`);
  assert.ok(TITLE_AT + TITLE_MS <= SPLASH_GATE);
  assert.ok(SUBLINE_AT + SUBLINE_MS <= SPLASH_GATE);
  const held = splashFrame(run(startClock(), clock => clock.held > 1000).clock, 0, size);
  assert.deepEqual(held.agents.map(agent => agent.opacity), SPLASH_AGENTS.map(() => 0));
  assert.equal(held.title, 1);
  assert.equal(held.subline, 1);
  assert.equal(held.lit, false);
  assert.equal(held.ring.opacity, 0);
});

test("no incoming agent crosses the wordmark or tagline while they are showing", () => {
  // Offsets from the core centre (bootSplash.css: identity at +96px; 30px/1.2 wordmark, 14px gap, 13px tagline),
  // widened by the 5px drift plus a pixel.
  const text = [{ left: -101, right: 101, top: 90, bottom: 138 }, { left: -114, right: 114, top: 140, bottom: 170 }];
  for (const view of [size, { width: 938, height: 618 }]) {
    for (let t = TITLE_AT; t <= SPLASH_GATE; t += 10) {
      splashFrame({ ...startClock(), t }, 0, view).agents.forEach((agent, index) => {
        if (agent.opacity < 0.05) return;
        const half = 32 * agent.scale;
        for (const box of text) {
          const overlaps = agent.x + half > box.left && agent.x - half < box.right && agent.y + half > box.top && agent.y - half < box.bottom;
          assert.ok(!overlaps, `${SPLASH_AGENTS[index].name} crosses the text at ${t} ms in ${view.width}×${view.height}`);
        }
      });
    }
  }
});

test("a ready app enters as soon as the finale ends: finale then exit fade, no idle tail", () => {
  const waiting = run(startClock(), clock => clock.held >= 3000).clock;
  const ready = settleClock(waiting, "ready");
  assert.equal(splashFrame(ready, 0, size).status, "ready");
  const { clock, elapsed } = run(ready, clock => clock.exit >= 1);
  assert.equal(splashPhase(clock), "done");
  assert.ok(Math.abs(elapsed - (SPLASH_FINALE + SPLASH_EXIT)) <= 17, `took ${elapsed} ms after ready`);
  const lit = splashFrame(run(ready, clock => clock.t >= SPLASH_GATE + SPLASH_FINALE).clock, 0, size);
  assert.equal(lit.core.opacity, 1, "the core is fully lit when the exit starts");
  assert.equal(lit.progress.fill, 1);
});

test("a fast load speeds the rest of the intro up instead of making the user wait it out", () => {
  const atNormalSpeed = SPLASH_GATE + SPLASH_FINALE + SPLASH_EXIT;
  const instant = run(settleClock(startClock(), "ready"), clock => clock.exit >= 1).elapsed;
  assert.ok(instant < atNormalSpeed - 600, `instant load took ${instant} ms`);
  assert.ok(instant <= 2200, `instant load took ${instant} ms`);
  const partway = run(startClock(), clock => clock.t >= 1200).clock;
  const later = run(settleClock(partway, "ready"), clock => clock.exit >= 1).elapsed;
  assert.ok(later < SPLASH_GATE - 1200 + SPLASH_FINALE + SPLASH_EXIT, `ready at 1.2 s took ${later} ms more`);
});

test("a failed start reveals the error screen promptly, without the finale", () => {
  for (const at of [0, 900, SPLASH_GATE]) {
    const before = run(startClock(), clock => clock.t >= at && (at < SPLASH_GATE || clock.held > 200)).clock;
    const failed = settleClock(before, "failed");
    const frame = splashFrame(failed, 0, size);
    assert.equal(frame.status, "failed");
    assert.equal(frame.lit, false);
    const { elapsed } = run(failed, clock => clock.exit >= 1);
    assert.ok(elapsed <= 260, `failure at ${at} ms took ${elapsed} ms to clear`);
  }
});

test("the first outcome wins", () => {
  const ready = settleClock(startClock(), "ready");
  assert.equal(settleClock(ready, "failed").outcome, "ready");
});

test("the status only claims the runtime is pending after a real wait at the gate", () => {
  const atGate = run(startClock(), clock => clock.t >= SPLASH_GATE).clock;
  assert.equal(splashFrame(atGate, 0, size).status, "gathering");
  const waited = run(atGate, clock => clock.held >= CONNECTING_AFTER_MS).clock;
  assert.equal(splashFrame(waited, 0, size).status, "connecting");
});

test("reduced motion shows a still composition and only fades once ready", () => {
  const still = run(startClock(true), clock => clock.held >= 2000).clock;
  const frame = splashFrame(still, 1234, size);
  assert.ok(frame.agents.every(agent => agent.opacity === 0));
  assert.equal(frame.dust, 0);
  assert.equal(frame.title, 1);
  assert.equal(splashFrame(still, 9876, size).core.scale, frame.core.scale, "no breathing");
  const { elapsed } = run(settleClock(still, "ready"), clock => clock.exit >= 1);
  assert.ok(elapsed <= SPLASH_EXIT + 17, `reduced exit took ${elapsed} ms`);
});
