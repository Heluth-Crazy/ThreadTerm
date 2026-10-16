import assert from 'node:assert/strict';
import test from 'node:test';
import { nextViewportFollow, shouldPauseViewportForFocus } from './useChatViewport';

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

test('a delayed upward scroll at stable dimensions preserves follow without input', () => {
  const bottom = position(1_482);
  const scrolled = position(1_200);
  assert.equal(nextViewportFollow(true, false, bottom, scrolled), true);
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

test('a coalesced stale scroll after the layout correction cannot revoke follow', () => {
  const before = position(767, 1_328, 561);
  const grown = position(767, 1_501, 561);
  const corrected = { ...grown, scrollTop: 940 };
  let follow = nextViewportFollow(true, false, before, grown);
  assert.equal(follow, true, 'layout scroll before ResizeObserver');
  follow = nextViewportFollow(follow, false, grown, corrected);
  assert.equal(follow, true, 'programmatic correction');
  for (const stale of [grown, corrected, grown, grown]) {
    follow = nextViewportFollow(follow, false, corrected, stale);
    assert.equal(follow, true, 'late scroll/live-change at identical dimensions');
  }
});

test('scroll and scrollend observations before a programmatic write applies keep follow', () => {
  const requested = position(1_482);
  const stale = position(1_310);
  for (const previous of [undefined, requested, stale]) {
    assert.equal(nextViewportFollow(true, false, previous, stale), true);
  }
});

test('explicit upward input stays paused through a queued old bottom observation', () => {
  const bottom = position(1_482);
  // Upward wheel/key/touch latches inspection before the default scroll occurs.
  assert.equal(nextViewportFollow(false, true, bottom, bottom), false);
  assert.equal(nextViewportFollow(false, true, bottom, position(1_310)), false);
  assert.equal(nextViewportFollow(false, true, bottom, position(1_482, 2_300)), false);
  // A downward input clears inspection; reaching bottom can resume follow.
  assert.equal(nextViewportFollow(false, false, position(1_310), bottom), true);
});

test('only an active native scrollbar gesture can turn an upward observation into a pause', () => {
  const bottom = position(1_482);
  const up = position(1_310);
  assert.equal(nextViewportFollow(true, false, bottom, up, false), true);
  assert.equal(nextViewportFollow(true, false, bottom, up, true), false);
  assert.equal(nextViewportFollow(true, false, bottom, position(1_481), true), false, 'small upward drag also pauses');
  assert.equal(nextViewportFollow(true, false, bottom, bottom, true), true, 'stationary click keeps follow');
  assert.equal(nextViewportFollow(true, false, up, bottom, true), true, 'downward drag keeps follow');
  assert.equal(nextViewportFollow(true, false, bottom, up, false), true, 'released gesture cannot classify future scrolls');
});


test('reversing a scrollbar drag down to the bottom resumes after its upward pause', () => {
  const bottom = position(1_482), up = position(1_310);
  assert.equal(nextViewportFollow(true, false, bottom, up, true), false);
  assert.equal(nextViewportFollow(false, true, up, up, true), false, 'queued stationary event keeps pause');
  assert.equal(nextViewportFollow(false, true, up, position(1_350), true), false, 'downward drag still above bottom');
  assert.equal(nextViewportFollow(false, true, position(1_350), bottom, true), true);
});

test('focus on earlier content pauses before the browser applies its scroll', () => {
  const bottom = position(1_482);
  assert.equal(shouldPauseViewportForFocus(bottom, 900), true);
  assert.equal(nextViewportFollow(false, true, bottom, bottom), false, 'queued bottom scroll cannot clear navigation intent');
  assert.equal(nextViewportFollow(false, true, bottom, position(900, 2_200)), false, 'stream and layout preserve the focused card');
});

test('focus after the browser reveals a card pauses even if its target is in the last viewport', () => {
  assert.equal(shouldPauseViewportForFocus(position(1_200), 1_500), true);
  assert.equal(shouldPauseViewportForFocus(position(1_458), 1_500), true, 'same 24 px follow threshold');
});

test('focus inside the latest viewport or a transcript without overflow keeps follow', () => {
  assert.equal(shouldPauseViewportForFocus(position(1_482), 1_500), false);
  assert.equal(shouldPauseViewportForFocus(position(1_481.6), 1_458), false, 'fractional layout and threshold tolerance');
  assert.equal(shouldPauseViewportForFocus(position(0, 300, 562), 0), false);
});

test('focus pause stays latched until an explicit downward input or jump resumes follow', () => {
  const bottom = position(1_482), target = position(900);
  assert.equal(nextViewportFollow(false, true, target, bottom), false, 'focus inspection survives a passive bottom observation');
  assert.equal(nextViewportFollow(false, false, target, bottom), true, 'downward intent reaching bottom resumes');
});
