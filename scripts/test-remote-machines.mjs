import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['desktop/test/remote-machines.test.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'desktop-dist/remote-machines.test.cjs' });
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=30000', 'desktop-dist/remote-machines.test.cjs'], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
