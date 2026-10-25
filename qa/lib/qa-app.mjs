// Builds a throwaway ThreadTerm app (desktop main/preload/html-preview preload bundles plus the renderer) into a temp
// directory. A harness hands Electron that directory instead of the repository root, so it never runs the user's own
// desktop-dist bundle: that one can be stale, and rebuilding it while the user's dev app is running is not allowed.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// desktop/src/main.ts loads each of these from its own directory (join(__dirname, …)), so all three are built here.
const mainBundles = ['main', 'preload', 'htmlPreviewSandboxPreload'];

/**
 * Builds the production app into `outDir` (default: a fresh directory under the system temp dir).
 * Returns `{ appDir, cleanup }`; `cleanup` removes the built app and is meant for a harness `finally`.
 * Pass `viteOptions` for extra Vite configuration (`root`, `plugins`, …).
 * The app lives outside the repository, so launch it with THREADTERM_V3_RUNTIME set to a runtime binary: an
 * unpackaged app otherwise looks for `runtime/Cargo.toml` next to itself.
 */
export async function buildQaApp({ root = repoRoot, outDir, viteOptions = {} } = {}) {
  const scratch = outDir ? undefined : await mkdtemp(join(tmpdir(), 'tt-qa-app-'));
  const appDir = outDir ? resolve(outDir) : join(scratch, 'app');
  const cleanup = () => rm(scratch ?? appDir, { recursive: true, force: true });
  try {
    await mkdir(appDir, { recursive: true });
    for (const name of mainBundles) {
      await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
    }
    await viteBuild({
      ...(process.env.THREADTERM_QA_RENDERER_ROOT ? { root: resolve(process.env.THREADTERM_QA_RENDERER_ROOT) } : {}),
      configFile: join(root, 'vite.config.ts'),
      logLevel: 'warn',
      ...viteOptions,
      build: { outDir: join(appDir, 'renderer'), emptyOutDir: true, ...viteOptions.build },
    });
    // Electron reads name and version from here (app.getName/app.getVersion); keep them equal to the repository's.
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'main.cjs' }));
    return { appDir, cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}
