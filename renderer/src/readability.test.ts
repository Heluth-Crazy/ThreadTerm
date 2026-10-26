import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contrastRatio,
  foregroundRequirements,
  minimumOverlay,
  mix,
  parseColor,
  readabilityTargets,
  relativeLuminance,
  type ForegroundPalette,
  type ForegroundRequirement,
} from './appearance/readability';
import type { ImageStats } from '../../desktop/src/backgroundImagesCore';

const dark: ForegroundPalette = {
  text: '#f2f6fb',
  muted: '#93a3b5',
  syn: ['#8ab4f8', '#81c995', '#fdd663', '#f28b82'],
  ansi: ['#1b1f27', '#ff6b6b', '#7ee787', '#f2cc60', '#79c0ff', '#d2a8ff', '#56d4dd', '#e6edf3', '#6e7681', '#ffa198', '#9be9a8', '#f8e3a1', '#a5d6ff', '#e2c5ff', '#9beef7', '#ffffff'],
};
const light: ForegroundPalette = {
  text: '#1b1f26',
  muted: '#586070',
  syn: ['#0b62d6', '#1a7f37', '#8a5a00', '#bf3989'],
  ansi: ['#f8f8f8', '#b91c1c', '#15803d', '#a16207', '#1d4ed8', '#7e22ce', '#0e7490', '#111827', '#6b7280', '#dc2626', '#16a34a', '#ca8a04', '#2563eb', '#9333ea', '#0891b2', '#374151'],
};
const darkRegion = { regionColor: '#182430', frameColor: '#0b1016' };
const lightRegion = { regionColor: '#ffffff', frameColor: '#f2f3f5' };
/** Black and white stripes: the mockup's stress image, worst case for both themes. */
const stress: ImageStats = { dark: [[0, 0, 0]], bright: [[255, 255, 255]] };
const midGrey: ImageStats = { dark: [[104, 104, 104]], bright: [[140, 140, 140]] };

function requirements(palette: ForegroundPalette, regionColor: string, region: 'chat' | 'editor' | 'terminal') {
  return foregroundRequirements(palette, regionColor, region);
}

/** The floor has to hold: re-check the composite it claims to protect. */
function assertFloorHolds(
  floor: number,
  image: { stats: ImageStats; opacity: number },
  region: typeof darkRegion,
  needs: readonly ForegroundRequirement[],
  source: 'own' | 'window' = 'own',
  windowOverlay = 0,
) {
  const regionBase = parseColor(region.regionColor)!;
  const frameBase = parseColor(region.frameColor)!;
  for (const pixel of [...image.stats.dark, ...image.stats.bright]) {
    let surface = mix(pixel as [number, number, number], source === 'window' ? frameBase : regionBase, image.opacity);
    if (source === 'window' && windowOverlay > 0) surface = mix(frameBase, surface, windowOverlay);
    const composed = mix(regionBase, surface, floor);
    for (const need of needs) {
      assert.ok(contrastRatio(need.color, composed) >= need.need - 1e-9,
        `floor ${floor} keeps ${need.need.toFixed(2)}:1 on ${composed.join(',')} (got ${contrastRatio(need.color, composed).toFixed(2)})`);
    }
  }
}

test('colour helpers follow WCAG', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseColor('#182430'), [24, 36, 48]);
  assert.deepEqual(parseColor('182430'), [24, 36, 48]);
  assert.equal(parseColor('#12345'), undefined);
  assert.equal(parseColor('rebeccapurple'), undefined);
  assert.ok(Math.abs(relativeLuminance([255, 255, 255]) - 1) < 1e-9);
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  assert.ok(Math.abs(contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 1e-9);
  assert.deepEqual(mix([255, 255, 255], [0, 0, 0], 0.5), [128, 128, 128]);
  assert.deepEqual(mix([255, 255, 255], [0, 0, 0], 0), [0, 0, 0]);
});

test('editor and terminal ask for 7:1 body text, every other region 4.5:1; secondary text 3:1', () => {
  assert.deepEqual(readabilityTargets('editor'), { text: 7, muted: 3 });
  assert.deepEqual(readabilityTargets('terminal'), { text: 7, muted: 3 });
  for (const region of ['window', 'sidebar', 'sidebar2', 'chat', 'browser'] as const) {
    assert.deepEqual(readabilityTargets(region), { text: 4.5, muted: 3 }, region);
  }
});

test('a requirement never exceeds the contrast the palette already has', () => {
  const flat: ForegroundPalette = { text: '#777777', muted: '#8a8a8a' };
  const needs = requirements(flat, '#7b7b7b', 'chat');
  assert.equal(needs.length, 2);
  const base = parseColor('#7b7b7b')!;
  assert.ok(Math.abs(needs[0].need - contrastRatio(parseColor('#777777')!, base)) < 1e-9, 'below 4.5:1 on the solid surface, so that is the target');
  assert.ok(Math.abs(needs[1].need - Math.min(3, contrastRatio(parseColor('#8a8a8a')!, base))) < 1e-9);
  const normal = requirements(dark, darkRegion.regionColor, 'chat');
  assert.deepEqual(normal.map(item => item.need), [4.5, 3]);
});

test('syntax colours keep 85 % of their contrast in the editor, ANSI 1–7 in the terminal', () => {
  const base = parseColor(darkRegion.regionColor)!;
  const editor = requirements(dark, darkRegion.regionColor, 'editor');
  assert.equal(editor.length, 2 + dark.syn!.length);
  dark.syn!.forEach((value, index) => {
    const expected = contrastRatio(parseColor(value)!, base) * 0.85;
    assert.ok(Math.abs(editor[2 + index].need - expected) < 1e-9, `syntax colour ${value}`);
  });
  const terminal = requirements(dark, darkRegion.regionColor, 'terminal');
  assert.equal(terminal.length, 2 + 7, 'ANSI 1–7 only; ANSI 0 and 8–15 are not checked');
  dark.ansi!.slice(1, 8).forEach((value, index) => {
    const expected = contrastRatio(parseColor(value)!, base) * 0.85;
    assert.ok(Math.abs(terminal[2 + index].need - expected) < 1e-9, `ANSI colour ${value}`);
  });
  const chat = requirements(dark, darkRegion.regionColor, 'chat');
  assert.equal(chat.length, 2, 'chat checks text and secondary text only');
});

test('no image needs no floor', () => {
  const needs = requirements(dark, darkRegion.regionColor, 'chat');
  assert.deepEqual(minimumOverlay({ ...darkRegion, source: 'own', requirements: needs }), { floor: 0 });
  assert.deepEqual(minimumOverlay({ ...darkRegion, image: { stats: { dark: [], bright: [] }, opacity: 1 }, source: 'own', requirements: needs }), { floor: 0 });
  assert.deepEqual(minimumOverlay({ ...darkRegion, image: { stats: stress, opacity: 1 }, source: 'own', requirements: [] }), { floor: 0 });
});

test('black/white stress statistics: a high floor on a dark theme, and it meets every target', () => {
  const needs = requirements(dark, darkRegion.regionColor, 'editor');
  const image = { stats: stress, opacity: 1 };
  const { floor } = minimumOverlay({ ...darkRegion, image, source: 'own', requirements: needs });
  assert.ok(floor > 0.6, `a black/white image needs a strong overlay (got ${floor})`);
  assert.ok(floor <= 1);
  assertFloorHolds(floor, image, darkRegion, needs);
});

test('black/white stress statistics on a light theme: the floor protects dark text from black pixels', () => {
  const needs = requirements(light, lightRegion.regionColor, 'chat');
  const image = { stats: stress, opacity: 1 };
  const { floor } = minimumOverlay({ ...lightRegion, image, source: 'own', requirements: needs });
  assert.ok(floor > 0.4, `a black/white image needs a strong overlay (got ${floor})`);
  assertFloorHolds(floor, image, lightRegion, needs);
});

test('a mid-grey image needs a partial overlay, not a full one', () => {
  const needs = requirements(dark, darkRegion.regionColor, 'chat');
  const image = { stats: midGrey, opacity: 1 };
  const { floor } = minimumOverlay({ ...darkRegion, image, source: 'own', requirements: needs });
  assert.ok(floor > 0 && floor < 0.75, `mid grey needs a partial overlay (got ${floor})`);
  assertFloorHolds(floor, image, darkRegion, needs);
});

test('the floor is monotonic in the image opacity', () => {
  const needs = requirements(dark, darkRegion.regionColor, 'chat');
  const floors = [0, 0.25, 0.5, 0.75, 1].map(opacity => minimumOverlay({ ...darkRegion, image: { stats: stress, opacity }, source: 'own', requirements: needs }).floor);
  assert.deepEqual(floors, [...floors].sort((left, right) => left - right), `expected non-decreasing floors, got ${floors.join(', ')}`);
  assert.ok(floors[floors.length - 1] > floors[0]);
});

test('a region that inherits the window image composites under the window overlay', () => {
  const needs = requirements(dark, darkRegion.regionColor, 'chat');
  const image = { stats: stress, opacity: 1 };
  const shown = minimumOverlay({ ...darkRegion, image, source: 'window', windowOverlay: 0, requirements: needs }).floor;
  const covered = minimumOverlay({ ...darkRegion, image, source: 'window', windowOverlay: 1, requirements: needs }).floor;
  assert.ok(shown > covered, `a fully covered window image needs no protection (shown ${shown}, covered ${covered})`);
  assert.equal(covered, 0, 'the frame colour already carries the text');
  // With the window overlay at 1 the picture is invisible, so the picture's own statistics cannot matter.
  const other = minimumOverlay({ ...darkRegion, image: { stats: midGrey, opacity: 1 }, source: 'window', windowOverlay: 1, requirements: needs }).floor;
  assert.equal(other, covered);
  const half = minimumOverlay({ ...darkRegion, image, source: 'window', windowOverlay: 0.5, requirements: needs });
  assertFloorHolds(half.floor, image, darkRegion, needs, 'window', 0.5);
  assert.ok(half.floor > covered && half.floor < shown);
});

test('the editor target is stricter than chat on the same surface', () => {
  // Secondary text is not the binding requirement here, so the stricter 7:1 body-text target shows in the floor.
  const plain: ForegroundPalette = { text: dark.text, muted: '#c8d0da' };
  const image = { stats: midGrey, opacity: 1 };
  const chatNeeds = requirements(plain, darkRegion.regionColor, 'chat');
  const editorNeeds = requirements(plain, darkRegion.regionColor, 'editor');
  const chat = minimumOverlay({ ...darkRegion, image, source: 'own', requirements: chatNeeds }).floor;
  const editor = minimumOverlay({ ...darkRegion, image, source: 'own', requirements: editorNeeds }).floor;
  assert.ok(editor > chat, `editor ${editor} must be stricter than chat ${chat}`);
  assertFloorHolds(chat, image, darkRegion, chatNeeds);
  assertFloorHolds(editor, image, darkRegion, editorNeeds);
  // With syntax colours in the palette the editor floor never drops below the chat one either.
  const fullChat = requirements(dark, darkRegion.regionColor, 'chat');
  const fullEditor = requirements(dark, darkRegion.regionColor, 'editor');
  assert.ok(minimumOverlay({ ...darkRegion, image, source: 'own', requirements: fullEditor }).floor
    >= minimumOverlay({ ...darkRegion, image, source: 'own', requirements: fullChat }).floor);
});

test('an unsatisfiable requirement reaches 1 instead of silently passing', () => {
  // A foreground that is the region colour itself can never reach 5:1, whatever the overlay does.
  const needs: ForegroundRequirement[] = [{ color: parseColor(darkRegion.regionColor)!, need: 5 }];
  const result = minimumOverlay({ ...darkRegion, image: { stats: stress, opacity: 0.4 }, source: 'own', requirements: needs });
  assert.equal(result.floor, 1);
});

test('the floor is a 0.01 step, never above 1', () => {
  const needs = requirements(dark, darkRegion.regionColor, 'terminal');
  for (const opacity of [0.1, 0.33, 0.66, 0.9]) {
    const { floor } = minimumOverlay({ ...darkRegion, image: { stats: stress, opacity }, source: 'own', requirements: needs });
    assert.ok(floor >= 0 && floor <= 1);
    assert.equal(Math.round(floor * 100), floor * 100);
  }
});
