import assert from 'node:assert/strict';
import test from 'node:test';
import { nextViewportFollow } from './useChatViewport';

const position = (scrollTop: number, scrollHeight = 2_044, clientHeight = 562, clientWidth = 400) => ({ scrollTop, scrollHeight, clientHeight, clientWidth });

test('following survives the narrow-pane scroll event before ResizeObserver corrects it', () => {
  const wide = position(1_234.4, 1_796.4, 562, 900);
  const narrow = position(1_234.4);
  assert.ok(narrow.scrollHeight - narrow.scrollTop - narrow.clientHeight > 247);
  assert.equal(nextViewportFollow(true, false, wide, narrow), true);
  assert.equal(nextViewportFollow(true, false, narrow, position(1_482)), true);
});

test('following survives a height resize that clamps scrollTop upwards', () => {
  const before = position(1_482);
  const clamped = position(1_300, 2_044, 700);
  assert.equal(nextViewportFollow(true, false, before, clamped), true);
});

test('following survives composer resize, streamed output and live indicator mount/unmount', () => {
  let previous = position(1_481.6);
  let follow = nextViewportFollow(false, false, position(1_234.4), previous);
  assert.equal(follow, true, 'jump-to-latest tolerates a fractional remaining pixel');
  const changes = [
    position(1_481.6, 2_200, 610), // Prompt/preview mounts while composer shrinks.
    position(1_590, 2_500, 610), // Stream appends below the user message.
    position(1_890, 2_520, 610), // Live indicator mounts.
    position(1_910, 2_720, 610), // Later live pushes/text append.
    position(1_940, 2_700, 610), // Indicator unmounts; footer takes over.
  ];
  for (const current of changes) {
    follow = nextViewportFollow(follow, false, previous, current);
    assert.equal(follow, true);
    previous = { ...current, scrollTop: current.scrollHeight - current.clientHeight };
  }
});

test('a user scroll upwards at stable dimensions pauses follow', () => {
  const bottom = position(1_482);
  const scrolled = position(1_200);
  assert.equal(nextViewportFollow(true, false, bottom, scrolled), false);
});

test('upward input pauses before a simultaneous resize or streamed update', () => {
  const bottom = position(1_482);
  const resizedAndScrolled = position(1_200, 2_400, 550);
  // Wheel-up, upward navigation keys and touch movement set follow=false
  // synchronously before the browser scrolls, even if layout changes too.
  assert.equal(nextViewportFollow(false, false, bottom, resizedAndScrolled), false);
});

test('a paused viewport stays paused as output and indicator height change', () => {
  const paused = position(1_200);
  assert.equal(nextViewportFollow(false, false, paused, position(1_200, 2_300)), false);
  assert.equal(nextViewportFollow(false, false, paused, position(1_200, 2_024)), false);
});

test('scrolling back to the bottom resumes follow within the existing threshold', () => {
  assert.equal(nextViewportFollow(false, false, position(1_200), position(1_458)), false);
  assert.equal(nextViewportFollow(false, false, position(1_200), position(1_458.1)), true);
  assert.equal(nextViewportFollow(false, false, position(1_200), position(1_481.6)), true);
});

test('inspection stays paused even when layout or a scroll reaches the bottom', () => {
  assert.equal(nextViewportFollow(false, true, position(1_200), position(1_482)), false);
  assert.equal(nextViewportFollow(false, true, position(1_200), position(1_500, 2_400)), false);
});
