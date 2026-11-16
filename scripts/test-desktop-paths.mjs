import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch = await mkdtemp(join(tmpdir(), 'tt-desktop-paths-'));
try {
  const outputs = [];
  for (const name of ['relocationPaths', 'fileLocation']) {
    const outfile = join(scratch, `${name}.test.cjs`);
    await build({ entryPoints: [`desktop/src/${name}.test.ts`], bundle: true, platform: 'node', format: 'cjs', outfile });
    outputs.push(outfile);
  }
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=20000', ...outputs], { stdio: 'inherit', timeout: 30000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
