// What the catalog probes (catalog-header-menu, catalog-active-delete, catalog-confirm-layout, parity-catalog-actions)
// render: the parity seed read from the reference prototype, and the production renderer built fresh. They read one
// parity run's seed under qa/results, which is not in the repository, and the working tree's desktop-dist renderer,
// which may be stale; a fresh worktree could run neither (11-19).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQaApp } from '../lib/qa-app.mjs';
import { startReadonlyReferenceServer } from './reference-server.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const cached = join(root, 'qa/results/parity/visual-fixture.json');

/** The reference prototype's projects, trees, sessions, store and file contents, as `qa/parity.mjs` reads them. */
export async function visualSeed(electron) {
  try { return JSON.parse(await readFile(cached, 'utf8')); } catch { /* read it from the prototype below */ }
  const server = await startReadonlyReferenceServer(join(root, 'reference'));
  const profile = await mkdtemp(join(tmpdir(), 'threadterm-parity-seed-'));
  let app;
  try {
    app = await electron.launch({ args: [join(here, 'electron-static.cjs')], env: { ...process.env, TT_PARITY_PROFILE: profile }, timeout: 30000 });
    const page = await app.firstWindow();
    await page.addInitScript(() => localStorage.setItem('threadterm.app.v3', JSON.stringify({ welcomeSeen: true, theme: 'light' })));
    await page.goto(server.origin + '/prototype/');
    await page.waitForFunction(() => !!window.ThreadTermPrototype);
    const seed = await page.evaluate(() => {
      const api = window.ThreadTermPrototype;
      return { projects: api.projects, trees: api.trees, sessions: api.sessions(), store: api.store,
        fileContents: Object.fromEntries(Object.entries(api.projects).map(([id, p]) => [id, Object.fromEntries(p.files.map((path, index) => [path, api.fileValue(api.sessions().find(item => item.project === id), index)]))])) };
    });
    await mkdir(dirname(cached), { recursive: true });
    await writeFile(cached, JSON.stringify(seed, null, 2));
    return seed;
  } finally {
    await app?.close().catch(() => {});
    await server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/** The built renderer to serve: THREADTERM_QA_RENDERER_DIR when a harness built one already, else a fresh build. */
export async function productionRenderer() {
  if (process.env.THREADTERM_QA_RENDERER_DIR) return { dir: resolve(process.env.THREADTERM_QA_RENDERER_DIR), cleanup: async () => {} };
  const { appDir, cleanup } = await buildQaApp({ root });
  return { dir: join(appDir, 'renderer'), cleanup };
}
