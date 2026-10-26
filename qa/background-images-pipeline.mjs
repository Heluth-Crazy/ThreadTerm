// Real-app QA for the background image pipeline (task 10-26 appearance, phase D). Builds a throwaway app, launches it
// on virtual Desktop 1 with an isolated profile and no real agent CLI, then drives the renderer pipeline, the
// `threadterm-bg:` protocol and the desktop store. Nothing here is user-visible, so the harness prints PASS lines
// instead of screenshots.
//
// Usage: node qa/background-images-pipeline.mjs
// Needs a runtime binary: THREADTERM_V3_RUNTIME_BIN (default: <repo>/runtime/target-d1/debug/threadterm-v3-runtime.exe).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { electron } from './lib/desktop1.mjs';
import { buildQaApp } from './lib/qa-app.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-d1/debug/threadterm-v3-runtime.exe');
const base = resolve(process.env.TEMP ?? tmpdir());
const scratch = await mkdtemp(join(base, 'tt-bg-pipeline-'));
assert.equal(dirname(scratch).toLowerCase(), base.toLowerCase(), 'scratch stays inside the approved QA root');
const appDir = join(scratch, 'app'), sources = join(scratch, 'sources'), work = join(scratch, 'work');
const profile = join(scratch, 'profile'), data = join(scratch, 'data'), fakeBin = join(scratch, 'bin');
const backgrounds = join(profile, 'backgrounds'), cache = join(backgrounds, 'Cache');
const pickTarget = join(sources, 'big.png');
const report = { passed: false, checks: [], errors: [], limitations: [] };
const check = (value) => { report.checks.push(value); console.log(`PASS ${value}`); };
let app, page, releaseLock;

function env() {
  const value = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'temp', 'tmp', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime'].includes(key.toLowerCase())));
  Object.assign(value, {
    TEMP: base, TMP: base,
    // Only fake providers, node and System32: no real agent CLI can be started by accident.
    PATH: [fakeBin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-bg-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_PICK_BACKGROUND_QA: pickTarget,
  });
  assert.equal(Object.keys(value).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');
  return value;
}

const manifestPath = join(backgrounds, 'manifest.json');
const recordPath = id => join(backgrounds, `${id}.webp`);
const variantPath = (id, blur) => join(cache, `${id}-b${blur}.webp`);
const exists = async (path) => { try { await stat(path); return true; } catch { return false; } };
const readManifest = async () => JSON.parse(await readFile(manifestPath, 'utf8'));

/** Resolves the code of a rejected pipeline call, whether it kept `error.code` or only the flattened message. */
async function makeFixtures() {
  await mkdir(sources, { recursive: true });
  const written = await page.evaluate(async () => {
    const paint = (canvas, alpha) => {
      const context = canvas.getContext('2d');
      const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, alpha ? 'rgba(255,64,64,0.65)' : '#101820');
      gradient.addColorStop(0.5, alpha ? 'rgba(64,255,160,0.35)' : '#2b4a63');
      gradient.addColorStop(1, alpha ? 'rgba(64,64,255,0)' : '#f2f6fb');
      context.fillStyle = gradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = alpha ? 'rgba(255,255,255,0.2)' : '#ffe600';
      for (let x = 0; x < canvas.width; x += 97) context.fillRect(x, 0, 23, canvas.height);
    };
    const toBase64 = async (canvas, type, quality) => {
      const blob = await new Promise(done => canvas.toBlob(done, type, quality));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = '';
      for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      return { base64: btoa(text), bytes: bytes.length, type: blob.type };
    };
    const big = document.createElement('canvas'); big.width = 5000; big.height = 3000; paint(big, false);
    const small = document.createElement('canvas'); small.width = 320; small.height = 200; paint(small, false);
    const alpha = document.createElement('canvas'); alpha.width = 800; alpha.height = 600; paint(alpha, true);
    return { big: await toBase64(big, 'image/png'), small: await toBase64(small, 'image/jpeg', 0.9), alpha: await toBase64(alpha, 'image/webp', 0.9) };
  });
  await writeFile(pickTarget, Buffer.from(written.big.base64, 'base64'));
  await writeFile(join(sources, 'small.jpg'), Buffer.from(written.small.base64, 'base64'));
  await writeFile(join(sources, 'alpha.webp'), Buffer.from(written.alpha.base64, 'base64'));
  // Rejected sources: an animated container, vector text, text renamed to an image extension, and an over-cap file.
  await writeFile(join(sources, 'anim.gif'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  await writeFile(join(sources, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
  await writeFile(join(sources, 'photo.png'), 'this is a text file that pretends to be a PNG');
  await writeFile(join(sources, 'huge.png'), Buffer.alloc(41 * 1024 * 1024));
  return written;
}

const call = (name, ...args) => page.evaluate(([method, methodArgs]) => window.__ttBackground[method](...methodArgs), [name, args]);

/** An <img> load through the app's protocol: the natural size, or null when the request 404s or is blocked. */
const imageSize = (url) => page.evaluate(target => new Promise(done => {
  const image = new Image();
  image.onload = () => done({ width: image.naturalWidth, height: image.naturalHeight });
  image.onerror = () => done(null);
  image.src = target;
  setTimeout(() => done(null), 10000);
}), url);

try {
  assert.ok(existsSync(runtime), `missing runtime binary ${runtime}; build runtime/target-d1 (cargo build --manifest-path runtime/Cargo.toml --target-dir runtime/target-d1 -j 2)`);
  releaseLock = await acquireElectronQaLock({ directory: base });
  await mkdir(work, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await buildQaApp({ root, outDir: appDir });

  app = await electron.launch({ args: [appDir], cwd: root, env: env(), timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm));
  check('the app started with an isolated profile and the desktop bridge');

  const bundle = await esbuild({ entryPoints: [join(root, 'qa/fixtures/background-pipeline-qa.ts')], bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'error' });
  await page.evaluate(bundle.outputFiles[0].text);
  await page.waitForFunction(() => Boolean(window.__ttBackground));
  check('the renderer background pipeline loaded in the app page');

  const fixtures = await makeFixtures();
  check(`fixtures: ${fixtures.big.type} ${fixtures.big.bytes} B, ${fixtures.small.type} ${fixtures.small.bytes} B, ${fixtures.alpha.type} ${fixtures.alpha.bytes} B (with alpha)`);

  // --- import through the picker override, then dedupe through the drop path -------------------------------
  const first = await call('importBackgroundFromPicker');
  assert.ok(first && /^[a-f0-9]{64}$/.test(first.id), 'the picker import returned a record with a sha256 id');
  assert.equal(first.width, 3840, 'the stored original is downscaled to a 3840 px long edge');
  assert.equal(first.height, 2304, 'the aspect ratio is kept');
  assert.equal(first.name, 'big.png');
  assert.ok(first.stats.dark.length > 0 && first.stats.bright.length <= 48, 'dark statistics are present and bounded');
  assert.ok(first.stats.bright.length > 0 && first.stats.dark.length <= 48, 'bright statistics are present and bounded');
  assert.ok(first.stats.bright.at(-1)[0] > first.stats.dark[0][0], 'the bright set is brighter than the dark set');
  check(`picker import stored ${first.width}x${first.height} WebP with ${first.stats.dark.length}+${first.stats.bright.length} statistics`);

  const stored = await readFile(recordPath(first.id));
  assert.equal(stored.subarray(0, 4).toString('latin1'), 'RIFF', 'the stored file is a RIFF container');
  assert.equal(stored.subarray(8, 12).toString('latin1'), 'WEBP', 'the stored file is WebP');
  const manifest = await readManifest();
  assert.equal(manifest.version, 1);
  assert.equal(manifest.images.length, 1);
  assert.deepEqual(manifest.images[0].stats, first.stats, 'the manifest carries the statistics');
  check(`the manifest records the image and the file on disk is WebP (${stored.length} B)`);

  const deduped = await call('importBackgroundFromPath', join(sources, 'big.png'));
  assert.equal(deduped.id, first.id, 're-importing the same bytes dedupes to one record');
  assert.equal((await readManifest()).images.length, 1);
  check('re-importing the same picture deduped and kept a single record');

  // --- protocol ----------------------------------------------------------------------------------------------
  assert.deepEqual(await imageSize(`threadterm-bg://image/${first.id}`), { width: 3840, height: 2304 }, 'the protocol serves the original');
  check('threadterm-bg://image/<id> loads through the app protocol at the stored size');

  const jpeg = await call('importBackgroundFromPath', join(sources, 'small.jpg'));
  assert.equal(jpeg.width, 320, 'a small picture keeps its size');
  assert.equal((await readFile(recordPath(jpeg.id))).subarray(8, 12).toString('latin1'), 'WEBP', 'a JPEG source is re-encoded as WebP');
  const alpha = await call('importBackgroundFromPath', join(sources, 'alpha.webp'));
  assert.equal(alpha.width, 800);
  assert.ok(alpha.stats.dark.length > 0, 'a WebP with alpha still yields statistics');
  check('JPEG and WebP-with-alpha sources were prepared, re-encoded and stored');

  // --- blur variant ------------------------------------------------------------------------------------------
  const baked = await call('ensureBlurVariant', first, 8);
  assert.ok(baked.variants['8'], 'the record gained a blur variant');
  assert.equal(baked.variants['8'].width, 1920, 'a baked variant is at most 1920 px on the long edge');
  assert.ok(baked.variants['8'].stats.dark.length > 0, 'the variant carries its own statistics');
  assert.equal(await exists(variantPath(first.id, 8)), true, 'the variant lives under Cache/');
  assert.deepEqual(await imageSize(`threadterm-bg://image/${first.id}/b8`), { width: 1920, height: 1152 }, 'the baked variant is served');
  const again = await call('ensureBlurVariant', baked, 8);
  assert.deepEqual(again.variants['8'], baked.variants['8'], 'a baked variant is reused, not baked twice');
  assert.deepEqual((await readdir(cache)).filter(name => name.includes(first.id)), [`${first.id}-b8.webp`]);
  check('blur 8 baked once into Cache/<id>-b8.webp at 1920x1152 and is served by the protocol');

  // --- rejected sources --------------------------------------------------------------------------------------
  const rejected = await page.evaluate(async paths => {
    const codes = {};
    for (const [name, path] of Object.entries(paths)) {
      try { await window.__ttBackground.importBackgroundFromPath(path); codes[name] = 'stored'; }
      catch (error) { codes[name] = error.code ?? /background_image_[a-z_]+/.exec(String(error.message))?.[0] ?? 'unknown'; }
    }
    return codes;
  }, { gif: join(sources, 'anim.gif'), svg: join(sources, 'vector.svg'), text: join(sources, 'photo.png'), huge: join(sources, 'huge.png') });
  assert.deepEqual(rejected, {
    gif: 'background_image_unsupported',
    svg: 'background_image_unsupported',
    text: 'background_image_unsupported',
    huge: 'background_image_too_large',
  });
  check('GIF, SVG and text-renamed-.png are rejected as unsupported, a 41 MiB file as too large');
  assert.equal((await readManifest()).images.length, 3, 'rejected imports stored nothing');

  // --- 404s --------------------------------------------------------------------------------------------------
  const missingId = 'f'.repeat(64);
  // The browser normalises dot segments before a request reaches the handler, so a traversal either becomes an
  // ordinary (harmless) id or a shape the handler refuses — never a file path.
  for (const [label, url] of [
    ['a wrong id', `threadterm-bg://image/${missingId}`],
    ['a traversal to the manifest', `threadterm-bg://image/../../manifest.json`],
    ['a deep traversal out of the originals', `threadterm-bg://image/${first.id}/../../../../manifest.json`],
    ['an encoded traversal', 'threadterm-bg://image/%2e%2e%2f%2e%2e%2fmanifest.json'],
    ['a Windows path as the id', 'threadterm-bg://image/C:/Windows/win.ini'],
    ['a variant that was never baked', `threadterm-bg://image/${first.id}/b7`],
    ['blur 0', `threadterm-bg://image/${first.id}/b0`],
    ['blur beyond the cap', `threadterm-bg://image/${first.id}/b41`],
    ['a segment that is not a blur', `threadterm-bg://image/${first.id}/x8`],
  ]) {
    assert.equal(await imageSize(url), null, `${label} must not be served`);
    check(`${label} answered 404`);
  }
  assert.deepEqual(await imageSize(`threadterm-bg://image/${first.id}/b8`), { width: 1920, height: 1152 }, 'the good variant still works');

  // --- remove and prune -------------------------------------------------------------------------------------
  await call('removeBackgroundImage', jpeg.id);
  assert.equal(await exists(recordPath(jpeg.id)), false, 'remove deleted the original');
  assert.equal((await readManifest()).images.some(record => record.id === jpeg.id), false, 'remove deleted the record');
  assert.equal(await imageSize(`threadterm-bg://image/${jpeg.id}`), null, 'a removed image is no longer served');
  check('removeBackgroundImage deleted the file, the record and the served URL');

  await call('removeBackgroundImage', first.id);
  assert.equal(await exists(variantPath(first.id, 8)), false, 'remove deleted the baked variants as well');
  check('removeBackgroundImage deleted the baked blur variants too');

  await call('pruneBackgroundImages', [alpha.id]);
  const afterPrune = await readManifest();
  assert.deepEqual(afterPrune.images.map(record => record.id), [alpha.id], 'prune keeps exactly the given ids');
  assert.deepEqual((await readdir(backgrounds)).filter(name => /^[a-f0-9]{64}\.webp$/.test(name)), [`${alpha.id}.webp`], 'prune deleted the other originals');
  assert.deepEqual(await readdir(cache), [], 'prune deleted every cached variant');
  check('pruneBackgroundImages kept one image and deleted every other file');

  const listed = await call('listBackgroundImages');
  assert.deepEqual(listed.map(record => record.id), [alpha.id]);
  check('listBackgroundImages reads the manifest the desktop wrote');

  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  try { await app?.close(); } catch (error) { report.errors.push(`close: ${error.message}`); }
  try { await releaseLock?.(); } catch { /* lock already gone */ }
  if (report.passed) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  else console.error(`scratch kept for inspection: ${scratch}`);
  console.log(`background pipeline QA: ${report.passed ? 'PASS' : 'FAIL'} (${report.checks.length} checks)`);
  if (report.errors.length) console.error(report.errors.join('\n'));
  process.exit(report.passed ? 0 : 1);
}
