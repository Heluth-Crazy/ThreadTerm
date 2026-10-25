import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch = await mkdtemp(join(tmpdir(), 'tt-desktop-paths-'));
try {
  const outfile = join(scratch, 'relocationPaths.test.cjs');
  await build({ entryPoints: ['desktop/src/relocationPaths.test.ts'], bundle: true, platform: 'node', format: 'cjs', outfile });
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=20000', outfile], { stdio: 'inherit', timeout: 30000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
