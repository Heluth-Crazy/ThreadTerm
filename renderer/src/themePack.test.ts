import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeBase64, exportedThemeNames, MAX_THEME_PACK_IMAGE_BYTES, parseThemePack, requestedBlurs, THEME_PACK_VERSION, ThemePackError, themePackErrorCode } from './appearance/themePack';
import type { ThemeBackgroundLayer, ThemeTokens } from './themes';

const white = 'a'.repeat(64);
const black = 'b'.repeat(64);
const palette: ThemeTokens = { background: '#1a1b26', surface: '#1f2335', text: '#c0caf5', muted: '#7aa2f7', accent: '#7aa2f7', border: '#1f2335' };
const layer = (id: string, over: Partial<ThemeBackgroundLayer> = {}): ThemeBackgroundLayer => ({
  image: id, opacity: 100, blur: 0, overlay: 60, fit: 'cover', focusX: 50, focusY: 50, scale: 100, ...over,
});
const bytes = (length: number, seed = 7) => Uint8Array.from({ length }, (_unused, index) => (index * 31 + seed) & 0xff);
const pack = (over: Record<string, unknown> = {}) => ({
  threadtermThemePack: THEME_PACK_VERSION,
  themes: { 'Tokyo Night (custom)': { ...palette, base: 'tokyo-night', backgrounds: { window: layer(white), chat: layer(black) } } },
  images: { [white]: { name: 'window.webp', webp: encodeBase64(bytes(64)) }, [black]: { name: 'chat.webp', webp: encodeBase64(bytes(96, 11)) } },
  ...over,
});

const codeOf = (run: () => unknown): string | undefined => {
  try { run(); return undefined; }
  catch (error) { return themePackErrorCode(error); }
};

test('the plain format still parses (map of names and a single { name, colors } theme)', () => {
  const map = parseThemePack({ Ocean: palette, Sunset: { ...palette, accent: '#ff7a90' } });
  assert.equal(map.version, 1);
  assert.deepEqual(Object.keys(map.themes), ['Ocean', 'Sunset']);
  assert.deepEqual(map.images, {});
  assert.deepEqual(map.missing, []);
  assert.deepEqual(map.themes.Ocean, palette);
  const single = parseThemePack({ name: 'Ocean', colors: palette });
  assert.deepEqual(single.themes, { Ocean: palette });
  const text = parseThemePack(JSON.stringify({ Ocean: palette }));
  assert.deepEqual(text.themes, { Ocean: palette });
  // The optional role colours and the base preset survive.
  const extended = parseThemePack({ Ocean: { ...palette, sidebar: '#16161e', editor: '#1f2335', base: 'tokyo-night' } });
  assert.equal(extended.themes.Ocean.base, 'tokyo-night');
  assert.equal(extended.themes.Ocean.sidebar, '#16161e');
});

test('a version 2 pack carries its pictures as bytes and its themes with backgrounds', () => {
  const parsed = parseThemePack(pack());
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.missing, []);
  const theme = parsed.themes['Tokyo Night (custom)'];
  assert.equal(theme.base, 'tokyo-night');
  assert.deepEqual(theme.backgrounds?.window, layer(white));
  assert.deepEqual(parsed.images[white].bytes, bytes(64));
  assert.equal(parsed.images[white].name, 'window.webp');
  assert.equal(parsed.images[black].bytes.length, 96);
  // A serialised file parses the same way.
  assert.deepEqual(parseThemePack(JSON.stringify(pack())).themes, parsed.themes);
  // An empty images map is a valid version 2 pack (a theme may have lost its pictures).
  const empty = parseThemePack({ threadtermThemePack: 2, themes: { Plain: palette }, images: {} });
  assert.deepEqual(empty.images, {});
});

test('a theme that names a picture the pack does not carry is reported, not rejected', () => {
  const parsed = parseThemePack(pack({ images: { [white]: { name: 'window.webp', webp: encodeBase64(bytes(16)) } } }));
  assert.deepEqual(parsed.missing, [black]);
  assert.deepEqual(Object.keys(parsed.images), [white]);
});

test('a tampered or malformed picture rejects the pack with its own code', () => {
  assert.equal(codeOf(() => parseThemePack(pack({ images: { [white]: { name: 'x', webp: encodeBase64(bytes(8)) }, 'not-an-id': { name: 'y', webp: encodeBase64(bytes(8)) } } }))), 'theme_pack_invalid_image');
  assert.equal(codeOf(() => parseThemePack(pack({ images: { [white]: { name: 'x', webp: 'not base64 at all!' } } }))), 'theme_pack_invalid_image');
  assert.equal(codeOf(() => parseThemePack(pack({ images: { [white]: { name: 'x' } } }))), 'theme_pack_invalid_image');
  assert.equal(codeOf(() => parseThemePack(pack({ images: { [white]: 'nope' } }))), 'theme_pack_invalid_image');
  assert.equal(codeOf(() => parseThemePack(pack({ images: [] }))), 'theme_pack_unreadable');
  assert.equal(codeOf(() => parseThemePack(pack({ themes: [] }))), 'theme_pack_unreadable');
  assert.equal(codeOf(() => parseThemePack({ threadtermThemePack: 3, themes: {} })), 'theme_pack_unreadable');
  // The error keeps its code in the message so it survives IPC.
  assert.match(String(new ThemePackError('theme_pack_invalid_image', 'abc').message), /^theme_pack_invalid_image: abc$/);
});

test('the picture budget is enforced before anything is written', () => {
  const big = { threadtermThemePack: 2, themes: { Ocean: palette }, images: { [white]: { name: 'a', webp: encodeBase64(bytes(128)) }, [black]: { name: 'b', webp: encodeBase64(bytes(128)) } } };
  assert.equal(codeOf(() => parseThemePack(big, { maxImageBytes: 255 })), 'theme_pack_too_large');
  assert.equal(codeOf(() => parseThemePack(big, { maxImageBytes: 256 })), undefined);
  assert.ok(MAX_THEME_PACK_IMAGE_BYTES >= 16 * 1024 * 1024, 'the default budget fits at least one 16 MiB original');
  const one = { threadtermThemePack: 2, themes: { Ocean: palette }, images: { [white]: { name: 'a', webp: encodeBase64(bytes(128)) } } };
  assert.equal(codeOf(() => parseThemePack(one, { maxImageBytes: 127 })), 'theme_pack_too_large');
});

test('themes and names are validated like the settings gate', () => {
  assert.equal(codeOf(() => parseThemePack({ Ocean: { ...palette, accent: 'blue' } })), 'theme_pack_invalid_theme');
  assert.equal(codeOf(() => parseThemePack({ Ocean: { ...palette, accent: '#abc' } })), 'theme_pack_invalid_theme');
  // Unknown keys are dropped by customTokens (the runtime is the strict gate when the theme is saved).
  assert.deepEqual(parseThemePack({ Ocean: { ...palette, extra: '#ffffff' } }).themes.Ocean, palette);
  assert.equal(codeOf(() => parseThemePack({ '': palette })), 'theme_pack_invalid_theme');
  const longName = 'x'.repeat(65);
  assert.equal(codeOf(() => parseThemePack({ Ocean: palette, [longName]: palette })), 'theme_pack_invalid_theme');
  assert.equal(codeOf(() => parseThemePack({})), 'theme_pack_empty');
  assert.equal(codeOf(() => parseThemePack([])), 'theme_pack_unreadable');
  assert.equal(codeOf(() => parseThemePack('')), 'theme_pack_unreadable');
  assert.equal(codeOf(() => parseThemePack('{ not json')), 'theme_pack_unreadable');
  assert.equal(codeOf(() => parseThemePack('null')), 'theme_pack_unreadable');
  // A BOM and surrounding whitespace are tolerated (the file comes from a text editor).
  assert.deepEqual(Object.keys(parseThemePack(`\uFEFF  ${JSON.stringify({ Ocean: palette })}  `).themes), ['Ocean']);
  // A background layer that does not validate is dropped and the palette kept (the strict gate is the settings one).
  const dropped = parseThemePack({ Ocean: { ...palette, backgrounds: { window: layer(white, { opacity: 250 }), chat: layer(black) } } });
  assert.deepEqual(dropped.themes.Ocean.backgrounds, { chat: layer(black) });
  assert.deepEqual(exportedThemeNames({ Ocean: palette, '': palette, Sunset: palette }), ['Ocean', 'Sunset']);
  assert.deepEqual(exportedThemeNames('nope'), []);
});

test('the blur values a pack asks for are listed once each', () => {
  assert.deepEqual(requestedBlurs({ a: { ...palette, backgrounds: { window: layer(white, { blur: 12 }), chat: layer(black, { blur: 4 }) } }, b: { ...palette, backgrounds: { editor: layer(white, { blur: 12 }) } } }), [4, 12]);
  assert.deepEqual(requestedBlurs({ a: palette }), []);
  // A layer that only shows the window picture has no picture of its own to blur.
  assert.deepEqual(requestedBlurs({ a: { ...palette, backgrounds: { window: layer(white, { blur: 12 }), chat: layer('inherit', { blur: 6 }) } } }), [12]);
});

test('an inherit layer is carried through a pack without an image to embed', () => {
  const themes = { Ocean: { ...palette, backgrounds: { window: layer(white), chat: layer('inherit', { overlay: 25 }) } } };
  const parsed = parseThemePack({ threadtermThemePack: 2, themes, images: { [white]: { name: 'window.webp', webp: encodeBase64(bytes(32)) } } });
  assert.deepEqual(parsed.themes.Ocean.backgrounds, themes.Ocean.backgrounds);
  assert.deepEqual(parsed.missing, [], 'an inherit layer never asks for a picture of its own');
  assert.deepEqual(Object.keys(parsed.images), [white]);
  // A window layer that inherits from itself is dropped, keeping the palette.
  const selfInherit = parseThemePack({ Ocean: { ...palette, backgrounds: { window: layer('inherit') } } });
  assert.equal(selfInherit.themes.Ocean.backgrounds, undefined);
  assert.deepEqual(selfInherit.themes.Ocean, palette);
});
