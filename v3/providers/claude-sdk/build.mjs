import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const nativeCliName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === 'win32' ? '.exe' : ''}`;
const bundledCli = require.resolve(nativeCliName);
mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/main.mjs'],
  outfile: 'dist/claude-sdk-host.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: "import { createRequire as __ttCreateRequire } from 'node:module'; const require = __ttCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});

// The official SDK resolves this optional platform package at runtime. Copying
// its CLI beside the host lets the packaged host supply an explicit path.
copyFileSync(bundledCli, join('dist', `claude-sdk-cli${process.platform === 'win32' ? '.exe' : ''}`));
