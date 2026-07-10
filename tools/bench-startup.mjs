import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const explicitTarget = process.env.THREADTERM_STARTUP_TARGET;
const timeoutMs = Number(process.env.THREADTERM_STARTUP_TIMEOUT_MS ?? 10_000);
const candidates = [
  explicitTarget,
  path.join(root, 'src-tauri', 'target', 'release', 'threadterm'),
  path.join(root, 'src-tauri', 'target', 'release', 'threadterm.exe'),
  path.join(
    root,
    'src-tauri',
    'target',
    'release',
    'bundle',
    'macos',
    'ThreadTerm.app',
    'Contents',
    'MacOS',
    'threadterm',
  ),
].filter(Boolean);

const target = candidates.find((candidate) => existsSync(candidate));

if (!target) {
  console.error(
    'No release executable found. Build first or set THREADTERM_STARTUP_TARGET=/path/to/executable.',
  );
  process.exit(1);
}

const iterations = Math.max(1, Number(process.env.THREADTERM_STARTUP_ITERATIONS ?? 3));
const samples = [];

for (let i = 0; i < iterations; i += 1) {
  samples.push(await measureSpawn(target));
}

samples.sort((a, b) => a.spawnObservedMs - b.spawnObservedMs);
const median = samples[Math.floor(samples.length / 2)];

console.log(`target\t${path.relative(root, target) || target}`);
console.log(`iterations\t${iterations}`);
for (const [index, sample] of samples.entries()) {
  console.log(`sample_${index + 1}\t${sample.spawnObservedMs.toFixed(2)} ms`);
}
console.log(`median_spawn_observed\t${median.spawnObservedMs.toFixed(2)} ms`);

async function measureSpawn(executable) {
  const start = process.hrtime.bigint();
  const child = spawn(executable, [], {
    stdio: 'ignore',
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`startup sample timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  child.kill();
  const elapsedNs = process.hrtime.bigint() - start;

  return {
    spawnObservedMs: Number(elapsedNs) / 1_000_000,
  };
}
