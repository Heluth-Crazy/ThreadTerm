import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';

const moduleRequire = createRequire(import.meta.url);

const PLATFORM_PACKAGE_BY_TARGET = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

function isExecutableFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableInPath(binaryName) {
  const pathEnv = process.env.PATH || '';
  const entries = pathEnv.split(path.delimiter).filter(Boolean);
  const isWindows = process.platform === 'win32';
  const extensions = isWindows
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .filter(Boolean)
      .map((ext) => ext.toLowerCase())
    : [''];

  for (const entry of entries) {
    if (!entry) continue;

    const candidateBase = path.join(entry, binaryName);
    if (isWindows) {
      for (const ext of extensions) {
        const candidate = candidateBase.toLowerCase().endsWith(ext)
          ? candidateBase
          : `${candidateBase}${ext}`;
        if (isExecutableFile(candidate)) {
          return candidate;
        }
      }
      continue;
    }

    if (isExecutableFile(candidateBase)) {
      return candidateBase;
    }
  }

  return null;
}

function getCodexTargetTriple() {
  const { platform: currentPlatform, arch } = process;

  if (currentPlatform === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
  }

  if (currentPlatform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
  }

  if (currentPlatform === 'linux' || currentPlatform === 'android') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
  }

  return null;
}

function resolveBundledCodexPath() {
  const targetTriple = getCodexTargetTriple();
  if (!targetTriple) {
    return null;
  }

  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!platformPackage) {
    return null;
  }

  try {
    const codexPackageJsonPath = moduleRequire.resolve('@openai/codex/package.json');
    const codexRequire = createRequire(codexPackageJsonPath);
    const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
    const vendorRoot = path.join(path.dirname(platformPackageJsonPath), 'vendor');
    const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const binaryPath = path.join(vendorRoot, targetTriple, 'codex', binaryName);
    const asarMarker = `${path.sep}app.asar${path.sep}`;

    if (binaryPath.includes(asarMarker)) {
      const unpackedBinaryPath = binaryPath.replace(
        asarMarker,
        `${path.sep}app.asar.unpacked${path.sep}`,
      );
      if (isExecutableFile(unpackedBinaryPath)) {
        return unpackedBinaryPath;
      }
      return null;
    }

    if (isExecutableFile(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // Fall through to PATH/default.
  }

  return null;
}

export function resolveCodexExecutablePath() {
  const explicitPathRaw = typeof process.env.CODEX_CLI_PATH === 'string'
    ? process.env.CODEX_CLI_PATH.trim()
    : '';
  const explicitPath = explicitPathRaw.replace(/^['"]|['"]$/g, '');

  if (explicitPath && isExecutableFile(explicitPath)) {
    return { path: explicitPath, source: 'CODEX_CLI_PATH' };
  }

  const systemCodexPath = findExecutableInPath('codex');
  if (systemCodexPath) {
    return { path: systemCodexPath, source: 'PATH' };
  }

  const bundledCodexPath = resolveBundledCodexPath();
  if (bundledCodexPath) {
    return { path: bundledCodexPath, source: 'bundled' };
  }

  if (explicitPathRaw) {
    return { path: explicitPathRaw, source: 'CODEX_CLI_PATH' };
  }

  return { path: null, source: 'sdk-default' };
}

export function getCodexExecutableVersion(executablePath) {
  if (!executablePath) {
    return null;
  }

  try {
    const probe = spawnSync(executablePath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
    });

    if (probe.error || probe.status !== 0) {
      return null;
    }

    const output = `${probe.stdout || ''}\n${probe.stderr || ''}`.trim();
    if (!output) {
      return null;
    }

    return output.split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

