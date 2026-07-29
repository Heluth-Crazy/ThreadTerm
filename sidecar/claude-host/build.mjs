// Bundle the sidecar into a single ESM file for tauri bundle.resources.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.mjs'],
  outfile: 'dist/claude-host.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: {
    js: "import { createRequire as __threadtermCreateRequire } from 'node:module'; const require = __threadtermCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
console.error('[build] dist/claude-host.mjs written');
