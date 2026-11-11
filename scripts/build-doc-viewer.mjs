// Bundle the sandboxed Word viewer into desktop-dist/doc-viewer (`design.md` §4.3).
// The HTML, script and stylesheet are the only names the document grant serves.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'desktop/doc-viewer/docx');
const output = join(root, 'desktop-dist/doc-viewer');
await mkdir(output, { recursive: true });
const common = {
  bundle: true,
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
};
await build({ ...common, entryPoints: [join(source, 'main.ts')], outfile: join(output, 'docx.js'), format: 'iife' });
await build({ ...common, entryPoints: [join(source, 'style.css')], outfile: join(output, 'docx.css') });
await copyFile(join(source, 'index.html'), join(output, 'docx.html'));
console.log('Built desktop-dist/doc-viewer/docx.html, docx.js and docx.css');
