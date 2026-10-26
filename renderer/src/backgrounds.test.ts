import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackgroundRecord, ImageStats } from '../../desktop/src/backgroundImagesCore';
import {
  customCopyName,
  customThemeFromResolved,
  placement,
  referencedImageIds,
  regionColor,
  regionRole,
  resolveBackgrounds,
} from './appearance/backgrounds';
import { contrastRatio, mix, parseColor } from './appearance/readability';
import { backgroundLayer, customTokens, resolveTheme, themeBackgrounds, type ThemeBackgroundLayer, type ThemeTokens } from './themes';

const white = 'a'.repeat(64);
const black = 'b'.repeat(64);
const plain = 'c'.repeat(64);
const stats = (color: [number, number, number]): ImageStats => ({ dark: [color], bright: [color] });

function record(id: string, imageStats: ImageStats, variants: BackgroundRecord['variants'] = {}): BackgroundRecord {
  return { id, name: `${id.slice(0, 4)}.webp`, width: 4000, height: 3000, bytes: 1024, importedAt: '2026-10-26T00:00:00.000Z', stats: imageStats, variants };
}

const layer = (id: string, over: Partial<ThemeBackgroundLayer> = {}): ThemeBackgroundLayer => ({
  image: id, opacity: 100, blur: 0, overlay: 10, fit: 'cover', focusX: 50, focusY: 50, scale: 100, ...over,
});

const dark = resolveTheme('preset:threadterm-dark', { systemDark: true });
const light = resolveTheme('preset:threadterm-light', { systemDark: false });

test('a stored layer is validated down to its exact shape and ranges', () => {
  const valid = layer(white, { fit: 'tile', opacity: 0, blur: 40, overlay: 100, focusX: 0, focusY: 100, scale: 200 });
  assert.deepEqual(backgroundLayer(valid), valid);
  const broken: unknown[] = [
    null, 'window', [],
    { ...layer(white), image: 'A'.repeat(64) },
    { ...layer(white), image: 'a'.repeat(63) },
    { ...layer(white), image: '../../manifest.json' },
    { ...layer(white), fit: 'fill' },
    { ...layer(white), opacity: 101 },
    { ...layer(white), opacity: -1 },
    { ...layer(white), opacity: 50.5 },
    { ...layer(white), blur: 41 },
    { ...layer(white), overlay: 101 },
    { ...layer(white), focusX: 101 },
    { ...layer(white), focusY: -1 },
    { ...layer(white), scale: 49 },
    { ...layer(white), scale: 201 },
    { ...layer(white), extra: 1 },
    { ...layer(white), overlay: '40' },
  ];
  for (const value of broken) assert.equal(backgroundLayer(value), undefined, JSON.stringify(value));
  const missing = layer(white) as unknown as Record<string, unknown>;
  delete missing.blur;
  assert.equal(backgroundLayer(missing), undefined);
  // Regions are an allow list; the valid part of a backgrounds value survives, an empty one disappears.
  assert.deepEqual(themeBackgrounds({ window: layer(white), inspector: layer(black), chat: { image: 'x' } }), { window: layer(white) });
  assert.equal(themeBackgrounds({ inspector: layer(white) }), undefined);
  assert.equal(themeBackgrounds({}), undefined);
  assert.equal(themeBackgrounds([]), undefined);
  assert.equal(themeBackgrounds('none'), undefined);
  // customTokens keeps the palette and only the valid backgrounds.
  const base = { background: light.colors.frame, surface: light.colors.panel, text: light.colors.text, muted: light.colors.muted, accent: light.colors.accent, border: light.colors.border };
  const tokens = customTokens({ ...base, backgrounds: { window: layer(white), chat: layer(black, { opacity: 900 }) } });
  assert.ok(tokens);
  assert.deepEqual(tokens.backgrounds, { window: layer(white) });
  assert.equal(customTokens({ ...base, backgrounds: {} })?.backgrounds, undefined);
  // `inherit` is a layer image like any other in the shape, but a window layer cannot use it.
  assert.deepEqual(backgroundLayer(layer('inherit')), layer('inherit'));
  assert.deepEqual(themeBackgrounds({ chat: layer('inherit') }), { chat: layer('inherit') });
  assert.equal(themeBackgrounds({ window: layer('inherit') }), undefined);
  assert.deepEqual(themeBackgrounds({ window: layer(white), chat: layer('inherit') }), { window: layer(white), chat: layer('inherit') });
  assert.deepEqual(customTokens({ ...base, backgrounds: { chat: layer('inherit') } })?.backgrounds, { chat: layer('inherit') });
  // Anything else that is not an image id is still refused.
  for (const image of ['Inherit', 'inherit ', 'inherited', '', '#inherit']) {
    assert.equal(backgroundLayer({ ...layer(white), image }), undefined, image);
  }
});

test('each region sits on the frame, sidebar, panel or editor colour like the mockup', () => {
  assert.equal(regionRole('window'), 'frame');
  assert.equal(regionRole('sidebar'), 'sidebar');
  assert.equal(regionRole('sidebar2'), 'panel');
  assert.equal(regionRole('chat'), 'panel');
  assert.equal(regionRole('editor'), 'editor');
  assert.equal(regionRole('terminal'), 'editor');
  assert.equal(regionRole('browser'), 'panel');
  assert.equal(regionColor(dark, 'editor'), dark.colors.editor);
  assert.equal(regionColor(dark, 'chat'), dark.colors.panel);
  assert.equal(regionColor(dark, 'window'), dark.colors.frame);
  assert.equal(regionColor(dark, 'sidebar'), dark.colors.sidebar);
});

test('a white picture over a dark theme raises the overlay until the text is readable again', () => {
  const records = [record(white, stats([255, 255, 255]))];
  const result = resolveBackgrounds(dark, { chat: layer(white, { overlay: 10 }) }, records);
  const chat = result.chat;
  assert.equal(chat.source, 'own');
  assert.equal(chat.imageUrl, `threadterm-bg://image/${white}`);
  assert.ok(chat.floor > 0.15 && chat.floor < 1, `the floor lifts the overlay (${chat.floor})`);
  assert.equal(chat.overlay, chat.floor);
  assert.equal(chat.raised, true);
  assert.equal(chat.needsBake, undefined);
  // The floor is not decoration: the theme text really is readable on the composited surface.
  const surface = mix(parseColor(dark.colors.panel)!, parseColor('#ffffff')!, chat.overlay);
  assert.ok(contrastRatio(parseColor(dark.colors.text)!, surface) >= 4.5);
  // Editor and terminal ask for 7:1, so their floor can only be higher.
  const editor = resolveBackgrounds(dark, { editor: layer(white, { overlay: 10 }) }, records).editor;
  assert.ok(editor.floor >= chat.floor);
});

test('a picture the palette already reads on keeps the chosen overlay', () => {
  const records = [record(black, stats([0, 0, 0]))];
  const result = resolveBackgrounds(dark, { chat: layer(black, { overlay: 40 }) }, records);
  assert.equal(result.chat.floor, 0);
  assert.equal(result.chat.overlay, 0.4);
  assert.equal(result.chat.raised, false);
  // No backgrounds at all: every region is plain.
  const empty = resolveBackgrounds(dark, undefined, records);
  for (const region of ['window', 'sidebar', 'sidebar2', 'chat', 'editor', 'terminal', 'browser'] as const) {
    assert.equal(empty[region].source, null);
    assert.equal(empty[region].overlay, 0);
    assert.equal(empty[region].imageUrl, undefined);
  }
});

test('a region without its own picture shows the window picture through the window overlay', () => {
  const records = [record(white, stats([255, 255, 255]))];
  const result = resolveBackgrounds(dark, { window: layer(white, { overlay: 10 }) }, records);
  assert.equal(result.window.source, 'own');
  assert.equal(result.window.raised, true);
  assert.equal(result.chat.source, 'window');
  assert.deepEqual(result.chat.layer, layer(white, { overlay: 10 }));
  assert.equal(result.chat.imageUrl, `threadterm-bg://image/${white}`);
  // The window overlay already dimmed the picture below the window's own floor, so the region needs nothing more.
  assert.equal(result.chat.floor, 0);
  assert.equal(result.chat.overlay, 0);
  assert.equal(result.chat.raised, false);
  // A lower window overlay leaves the regions more of the floor to lift themselves.
  const dim = resolveBackgrounds(dark, { window: layer(white, { overlay: 0 }) }, records);
  assert.ok(dim.window.floor > 0);
  assert.equal(dim.chat.source, 'window');
});

test('a region layer that inherits the window picture keeps its own overlay and floor', () => {
  const records = [record(white, stats([255, 255, 255]))];
  const inherit = (overlay: number) => layer('inherit', { overlay });
  // The window overlay already dimmed the picture, so a modest region overlay survives unchanged.
  const soft = resolveBackgrounds(dark, { window: layer(white, { overlay: 10 }), chat: inherit(55) }, records);
  assert.equal(soft.chat.source, 'window');
  assert.deepEqual(soft.chat.layer, layer(white, { overlay: 10 }), 'the picture geometry stays the window layer\'s');
  assert.equal(soft.chat.imageUrl, `threadterm-bg://image/${white}`);
  assert.equal(soft.chat.floor, 0);
  assert.equal(soft.chat.overlay, 0.55);
  assert.equal(soft.chat.raised, false);
  // A lower window overlay leaves a floor that lifts the region's own choice.
  const raised = resolveBackgrounds(dark, { window: layer(white, { overlay: 0 }), editor: inherit(5) }, records);
  assert.ok(raised.editor.floor > 0.05, `the floor is real (${raised.editor.floor})`);
  assert.equal(raised.editor.overlay, raised.editor.floor);
  assert.equal(raised.editor.raised, true);
  // An inherit layer whose window picture is gone shows nothing (and reports no missing id of its own).
  const orphan = resolveBackgrounds(dark, { window: layer(plain), chat: inherit(40) }, records);
  assert.equal(orphan.chat.source, null);
  assert.equal(orphan.chat.overlay, 0);
  assert.equal(orphan.chat.missing, undefined);
  // `inherit` is only meaningful below the window: the validator drops a window layer that names it.
  const windowInherits = resolveBackgrounds(dark, { window: inherit(40), chat: inherit(40) }, records);
  assert.equal(windowInherits.window.source, null);
  assert.equal(windowInherits.chat.source, null);
});

test('a blur that was never baked is reported instead of served', () => {
  const variantStats = stats([255, 255, 255]);
  const pending = resolveBackgrounds(dark, { window: layer(white, { blur: 12 }) }, [record(white, stats([255, 255, 255]))]);
  assert.equal(pending.window.imageUrl, undefined);
  assert.deepEqual(pending.window.needsBake, { id: white, blur: 12 });
  assert.ok(pending.window.floor > 0);
  const baked = resolveBackgrounds(dark, { window: layer(white, { blur: 12 }) }, [record(white, stats([255, 255, 255]), { '12': { width: 1920, height: 1440, stats: variantStats } })]);
  assert.equal(baked.window.imageUrl, `threadterm-bg://image/${white}/b12`);
  assert.equal(baked.window.needsBake, undefined);
  // The baked variant's own statistics decide the floor, not the sharp original's.
  const sharp = resolveBackgrounds(dark, { window: layer(white) }, [record(white, stats([200, 200, 200]))]);
  assert.ok(sharp.window.floor < baked.window.floor, 'a brighter variant needs a stronger overlay');
});

test('a picture the store lost is ignored, reported, and the region inherits the window picture', () => {
  const records = [record(white, stats([255, 255, 255]))];
  const result = resolveBackgrounds(dark, { window: layer(white), chat: layer(plain) }, records);
  assert.equal(result.chat.source, 'window');
  assert.equal(result.chat.missing, plain);
  const orphan = resolveBackgrounds(dark, { window: layer(plain) }, records);
  assert.equal(orphan.window.source, null);
  assert.equal(orphan.window.missing, plain);
  assert.equal(orphan.chat.source, null);
  assert.equal(orphan.chat.missing, undefined);
  // An invalid stored layer is dropped the same way (the palette still renders).
  const invalid = resolveBackgrounds(dark, { chat: { image: 'nope' } as unknown as ThemeBackgroundLayer }, records);
  assert.equal(invalid.chat.source, null);
});

test('placement covers, contains or tiles the picture around its focus point and scale', () => {
  const image = { width: 1000, height: 500 };
  const box = { x: 10, y: 20, w: 200, h: 200 };
  const cover = placement({ fit: 'cover', focusX: 50, focusY: 50, scale: 100 }, box, image);
  assert.deepEqual(cover, { size: '400px 200px', x: -90, y: 20, repeat: 'no-repeat' });
  const contained = placement({ fit: 'contain', focusX: 100, focusY: 100, scale: 100 }, box, image);
  assert.deepEqual(contained, { size: '200px 100px', x: 10, y: 120, repeat: 'no-repeat' });
  const zoomed = placement({ fit: 'cover', focusX: 0, focusY: 0, scale: 200 }, box, image);
  assert.deepEqual(zoomed, { size: '800px 400px', x: 10, y: 20, repeat: 'no-repeat' });
  const tiled = placement({ fit: 'tile', focusX: 100, focusY: 0, scale: 150 }, box, image);
  assert.deepEqual(tiled, { size: '480px 240px', x: 10, y: 20, repeat: 'repeat' });
  // A degenerate record cannot break a render.
  assert.deepEqual(placement({ fit: 'cover', focusX: 50, focusY: 50, scale: 100 }, { x: 0, y: 0, w: 100, h: 100 }, { width: 0, height: 0 }).size, '100px 100px');
});

test('a preset becomes a custom copy whose name does not collide', () => {
  assert.equal(customCopyName('Tokyo Night', []), 'Tokyo Night (custom)');
  assert.equal(customCopyName('Tokyo Night', ['Tokyo Night (custom)']), 'Tokyo Night (custom 2)');
  assert.equal(customCopyName('Tokyo Night', ['Tokyo Night (custom)', 'Tokyo Night (custom 2)']), 'Tokyo Night (custom 3)');
  // Adding a second background to an existing copy names a copy of the copy, not "(custom) (custom)".
  assert.equal(customCopyName('Tokyo Night (custom)', ['Tokyo Night (custom)']), 'Tokyo Night (custom 2)');
  assert.equal(customCopyName('Dark (custom 4)', ['Dark (custom)']), 'Dark (custom 2)');
  assert.equal(customCopyName('  Rosé Pine  ', []), 'Rosé Pine (custom)');
  assert.equal(customCopyName('', []), 'Custom (custom)');
});

test('a custom copy keeps all eight role colours, the base preset and its backgrounds', () => {
  const resolved = resolveTheme('preset:tokyo-night', { systemDark: true });
  const backgrounds = { window: layer(white, { blur: 6, overlay: 45 }), chat: layer(black, { fit: 'tile' as const }) };
  const tokens = customThemeFromResolved(resolved, backgrounds);
  assert.deepEqual(tokens, {
    background: resolved.colors.frame,
    surface: resolved.colors.panel,
    text: resolved.colors.text,
    muted: resolved.colors.muted,
    accent: resolved.colors.accent,
    border: resolved.colors.border,
    sidebar: resolved.colors.sidebar,
    editor: resolved.colors.editor,
    base: 'tokyo-night',
    backgrounds,
  });
  assert.deepEqual(customTokens(tokens), tokens);
  const round = resolveTheme('custom:Tokyo Night (custom)', { systemDark: false, customThemes: { 'Tokyo Night (custom)': tokens as ThemeTokens } });
  // accentFg is derived for custom themes (the preset's fixed pair is not part of the custom theme).
  assert.match(round.colors.accentFg, /^#[0-9a-f]{6}$/i);
  for (const role of ['frame', 'sidebar', 'panel', 'editor', 'text', 'muted', 'border', 'accent', 'ok', 'warn', 'danger'] as const) {
    assert.equal(round.colors[role], resolved.colors[role], role);
  }
  assert.equal(round.presetId, 'tokyo-night');
  assert.deepEqual(round.custom ? customTokens(tokens)?.backgrounds : undefined, backgrounds);
  // Without backgrounds the copy is a plain palette.
  assert.equal(customThemeFromResolved(light).backgrounds, undefined);
  // An invalid background can never leave this function (the settings validation would refuse the theme).
  assert.equal(customThemeFromResolved(light, { window: layer(white, { opacity: 101 } as unknown as Partial<ThemeBackgroundLayer>) }).backgrounds, undefined);
});

test('referencedImageIds is the keep list for pruning and ignores anything invalid', () => {
  const themes: Record<string, ThemeTokens> = {
    one: { background: '#000000', surface: '#111111', text: '#ffffff', muted: '#999999', accent: '#3b82f6', border: '#222222', backgrounds: { window: layer(white), chat: layer(black) } },
    two: { background: '#000000', surface: '#111111', text: '#ffffff', muted: '#999999', accent: '#3b82f6', border: '#222222', backgrounds: { editor: layer(white) } },
    broken: { background: '#000000', surface: '#111111', text: '#ffffff', muted: '#999999', accent: '#3b82f6', border: '#222222', backgrounds: { window: { image: '../../etc/passwd' } as unknown as ThemeBackgroundLayer } },
  };
  assert.deepEqual([...referencedImageIds(themes)].sort(), [black, white].sort());
  // A layer that only shows the window picture references no picture of its own.
  assert.deepEqual([...referencedImageIds({ one: { ...themes.one, backgrounds: { window: layer(white), chat: layer('inherit') } } })], [white]);
  assert.equal(referencedImageIds({ one: { ...themes.one, backgrounds: { chat: layer('inherit') } } }).size, 0);
  assert.equal(referencedImageIds(undefined).size, 0);
  assert.equal(referencedImageIds({}).size, 0);
});
