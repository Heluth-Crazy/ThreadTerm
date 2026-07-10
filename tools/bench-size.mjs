import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle');
const releaseDir = path.join(root, 'src-tauri', 'target', 'release');
const packageExtensions = new Set([
  '.AppImage',
  '.deb',
  '.dmg',
  '.exe',
  '.msi',
  '.rpm',
]);

const fixedTargets = [
  ['frontend_dist', path.join(root, 'dist')],
  ['mobile_dist', path.join(root, 'mobile-app', 'dist')],
  ['release_binary_unix', path.join(releaseDir, 'threadterm')],
  ['release_binary_windows', path.join(releaseDir, 'threadterm.exe')],
];

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function pathSize(targetPath) {
  const info = await stat(targetPath);
  if (!info.isDirectory()) {
    return info.size;
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    total += await pathSize(path.join(targetPath, entry.name));
  }
  return total;
}

async function collectBundleArtifacts(dir) {
  if (!(await exists(dir))) {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const artifacts = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(...(await collectBundleArtifacts(fullPath)));
      continue;
    }

    const extension = path.extname(entry.name);
    if (packageExtensions.has(extension)) {
      artifacts.push([`bundle:${path.relative(root, fullPath)}`, fullPath]);
    }
  }
  return artifacts;
}

function formatBytes(bytes) {
  const mib = bytes / 1024 / 1024;
  return `${bytes} B (${mib.toFixed(2)} MiB)`;
}

const targets = [...fixedTargets, ...(await collectBundleArtifacts(bundleDir))];
const rows = [];

for (const [name, targetPath] of targets) {
  if (!(await exists(targetPath))) {
    continue;
  }
  rows.push({
    name,
    path: path.relative(root, targetPath),
    bytes: await pathSize(targetPath),
  });
}

if (rows.length === 0) {
  console.log('No build artifacts found. Run npm run build, npm run build:mobile, or npm run tauri:build first.');
  process.exit(0);
}

for (const row of rows.sort((a, b) => a.path.localeCompare(b.path))) {
  console.log(`${row.name}\t${formatBytes(row.bytes)}\t${row.path}`);
}
