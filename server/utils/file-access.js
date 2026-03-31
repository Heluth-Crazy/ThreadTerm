import os from 'os';
import path from 'path';
import { promises as fsPromises } from 'fs';
import { spawn } from 'child_process';

export const FILE_ACCESS_MODES = Object.freeze({
  AUTO: 'Auto',
  TERMINAL_FIRST: 'Terminal First',
  DIRECT: 'Direct',
});

export const FILE_ACCESS_MODE_HEADER = 'x-openwork-file-access-mode';

const PRUNED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svn',
  '.hg',
]);

const SHELL_ERROR_MARKER = '__OW_ERROR__:';
const SHELL_ERROR_MESSAGES = {
  ENOENT: 'File or directory not found',
  EACCES: 'Permission denied',
  EISDIR: 'Path points to a directory',
  EEXIST: 'File or directory already exists',
};

function escapePowerShellSingleQuoted(value = '') {
  return String(value).replace(/'/g, "''");
}

function toPowerShellSingleQuoted(value = '') {
  return `'${escapePowerShellSingleQuoted(value)}'`;
}

function escapePosixSingleQuoted(value = '') {
  return String(value).replace(/'/g, `'"'"'`);
}

function toPosixSingleQuoted(value = '') {
  return `'${escapePosixSingleQuoted(value)}'`;
}

function isNoSuchFileError(error) {
  return error?.code === 'ENOENT';
}

export function normalizeFileAccessMode(rawValue) {
  const value = String(rawValue || '').trim().toLowerCase();

  if (!value || value === 'auto' || value === '自动') {
    return FILE_ACCESS_MODES.AUTO;
  }

  if (
    value === 'terminal first' ||
    value === 'terminal-first' ||
    value === 'terminal_first' ||
    value === 'terminalfirst' ||
    value === 'compatibility' ||
    value === 'compatibility mode' ||
    value === '兼容模式'
  ) {
    return FILE_ACCESS_MODES.TERMINAL_FIRST;
  }

  if (
    value === 'direct' ||
    value === 'high performance' ||
    value === 'high-performance' ||
    value === '高性能模式'
  ) {
    return FILE_ACCESS_MODES.DIRECT;
  }

  return FILE_ACCESS_MODES.AUTO;
}

export function resolveEffectiveFileAccessMode(rawValue, platform = os.platform()) {
  const requestedMode = normalizeFileAccessMode(rawValue);
  if (requestedMode === FILE_ACCESS_MODES.AUTO) {
    return platform === 'win32' ? FILE_ACCESS_MODES.TERMINAL_FIRST : FILE_ACCESS_MODES.DIRECT;
  }
  return requestedMode;
}

function permToRwx(perm) {
  const r = perm & 4 ? 'r' : '-';
  const w = perm & 2 ? 'w' : '-';
  const x = perm & 1 ? 'x' : '-';
  return r + w + x;
}

function formatPermissions(permText) {
  const normalized = String(permText || '').trim();
  if (!/^\d{3,4}$/.test(normalized)) {
    return {
      permissions: '',
      permissionsRwx: '',
    };
  }

  const digits = normalized.slice(-3);
  const ownerPerm = Number(digits[0]);
  const groupPerm = Number(digits[1]);
  const otherPerm = Number(digits[2]);

  return {
    permissions: digits,
    permissionsRwx: permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm),
  };
}

function createOperationError(code, fallbackMessage, cause = null) {
  const error = new Error(SHELL_ERROR_MESSAGES[code] || fallbackMessage || 'File operation failed');
  error.code = code;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function parseShellOperationError(error) {
  const combinedText = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n');
  const markerMatch = combinedText.match(/__OW_ERROR__:(\w+)/);
  if (!markerMatch) {
    return error;
  }
  return createOperationError(markerMatch[1], combinedText, error);
}

async function runShellScript({ script, cwd, platform = os.platform(), input }) {
  const isWindows = platform === 'win32';
  const shellBinary = isWindows ? 'powershell.exe' : '/bin/bash';
  const shellArgs = isWindows
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
    : ['-lc', script];

  return new Promise((resolve, reject) => {
    const child = spawn(shellBinary, shellArgs, {
      cwd,
      env: {
        ...process.env,
        LANG: process.env.LANG || 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    if (input !== undefined) {
      child.stdin.on('error', () => {
        // Ignore broken pipe if the script exits before consuming stdin.
      });
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error((stderr || stdout || `Shell command failed with exit code ${code}`).trim());
      error.code = code;
      error.stderr = stderr;
      error.stdout = stdout;
      reject(parseShellOperationError(error));
    });
  });
}

function decodeShellBase64(stdout) {
  const normalized = String(stdout || '').replace(/\s+/g, '');
  if (!normalized) {
    return Buffer.alloc(0);
  }
  return Buffer.from(normalized, 'base64');
}

function buildPosixFileTreeScript(rootPath, maxDepth, showHidden) {
  const showHiddenFlag = showHidden ? '1' : '0';

  return [
    'set -euo pipefail',
    `ROOT=${toPosixSingleQuoted(rootPath)}`,
    `MAX_DEPTH=${Number(maxDepth) || 1}`,
    `SHOW_HIDDEN=${showHiddenFlag}`,
    'list_dir() {',
    '  local dir="$1"',
    '  local depth="$2"',
    '  local child name rel type size modified perm encoded',
    '  shopt -s nullglob',
    '  if [ "$SHOW_HIDDEN" = "1" ]; then',
    '    shopt -s dotglob',
    '  else',
    '    shopt -u dotglob',
    '  fi',
    '  for child in "$dir"/*; do',
    '    [ -e "$child" ] || continue',
    '    name="$(basename "$child")"',
    '    case "$name" in',
    '      node_modules|dist|build|.git|.svn|.hg) continue ;;',
    '    esac',
    '    rel="${child#$ROOT/}"',
    '    if [ -d "$child" ]; then',
    '      type="directory"',
    '    else',
    '      type="file"',
    '    fi',
    '    if [ "$(uname -s)" = "Darwin" ]; then',
    "      size=\"$(stat -f '%z' -- \"$child\" 2>/dev/null || printf '0')\"",
    "      modified=\"$(stat -f '%m' -- \"$child\" 2>/dev/null || printf '0')\"",
    "      perm=\"$(stat -f '%Lp' -- \"$child\" 2>/dev/null || printf '')\"",
    '    else',
    "      size=\"$(stat -c '%s' -- \"$child\" 2>/dev/null || printf '0')\"",
    "      modified=\"$(stat -c '%Y' -- \"$child\" 2>/dev/null || printf '0')\"",
    "      perm=\"$(stat -c '%a' -- \"$child\" 2>/dev/null || printf '')\"",
    '    fi',
    "    encoded=\"$(printf '%s' \"$rel\" | base64 | tr -d '\\n')\"",
    "    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$encoded\" \"$type\" \"$size\" \"$modified\" \"$perm\"",
    '    if [ -d "$child" ] && [ "$depth" -lt "$MAX_DEPTH" ]; then',
    '      list_dir "$child" $((depth + 1))',
    '    fi',
    '  done',
    '}',
    'list_dir "$ROOT" 0',
  ].join('\n');
}

function buildPowerShellFileTreeScript(rootPath, maxDepth, showHidden) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$root = ${toPowerShellSingleQuoted(rootPath)}`,
    `$maxDepth = ${Number(maxDepth) || 1}`,
    `$showHidden = ${showHidden ? '$true' : '$false'}`,
    "$skipNames = @('node_modules', 'dist', 'build', '.git', '.svn', '.hg')",
    'function Emit-Entries {',
    '  param([string]$DirPath, [int]$Depth)',
    '  try {',
    '    $children = Get-ChildItem -LiteralPath $DirPath -Force -ErrorAction Stop',
    '  } catch {',
    '    return',
    '  }',
    '  foreach ($child in $children) {',
    '    if ($skipNames -contains $child.Name) { continue }',
    "    if (-not $showHidden -and $child.Name.StartsWith('.')) { continue }",
    '    $relativePath = [System.IO.Path]::GetRelativePath($root, $child.FullName)',
    "    if ([string]::IsNullOrWhiteSpace($relativePath) -or $relativePath -eq '.') { continue }",
    '    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($relativePath))',
    "    $type = if ($child.PSIsContainer) { 'directory' } else { 'file' }",
    '    $size = if ($child.PSIsContainer -or $null -eq $child.Length) { 0 } else { [int64]$child.Length }',
    '    $modified = [DateTimeOffset]$child.LastWriteTimeUtc',
    '    Write-Output ($encoded + "`t" + $type + "`t" + $size + "`t" + $modified.ToUnixTimeSeconds() + "`t")',
    '    if ($child.PSIsContainer -and $Depth -lt $maxDepth) {',
    '      Emit-Entries -DirPath $child.FullName -Depth ($Depth + 1)',
    '    }',
    '  }',
    '}',
    'Emit-Entries -DirPath $root -Depth 0',
  ].join('\n');
}

function buildPosixReadBase64Script(targetPath) {
  return [
    'set -euo pipefail',
    `TARGET=${toPosixSingleQuoted(targetPath)}`,
    'if [ ! -e "$TARGET" ]; then printf "' + SHELL_ERROR_MARKER + 'ENOENT" >&2; exit 44; fi',
    'if [ -d "$TARGET" ]; then printf "' + SHELL_ERROR_MARKER + 'EISDIR" >&2; exit 46; fi',
    'if [ ! -r "$TARGET" ]; then printf "' + SHELL_ERROR_MARKER + 'EACCES" >&2; exit 45; fi',
    'base64 < "$TARGET" | tr -d "\\n"',
  ].join('\n');
}

function buildPowerShellReadBase64Script(targetPath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${toPowerShellSingleQuoted(targetPath)}`,
    `if (-not (Test-Path -LiteralPath $target)) { [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}ENOENT'); exit 44 }`,
    '$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop',
    `if ($item.PSIsContainer) { [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}EISDIR'); exit 46 }`,
    'try {',
    '  $bytes = [System.IO.File]::ReadAllBytes($target)',
    '} catch [System.UnauthorizedAccessException] {',
    `  [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}EACCES')`,
    '  exit 45',
    '}',
    '[Console]::Out.Write([Convert]::ToBase64String($bytes))',
  ].join('\n');
}

function buildPosixWriteFromStdinScript(targetPath) {
  return [
    'set -euo pipefail',
    `TARGET=${toPosixSingleQuoted(targetPath)}`,
    'PARENT="$(dirname "$TARGET")"',
    'if [ ! -d "$PARENT" ]; then printf "' + SHELL_ERROR_MARKER + 'ENOENT" >&2; exit 44; fi',
    'if [ -e "$TARGET" ] && [ -d "$TARGET" ]; then printf "' + SHELL_ERROR_MARKER + 'EISDIR" >&2; exit 46; fi',
    'if [ -e "$TARGET" ] && [ ! -w "$TARGET" ]; then printf "' + SHELL_ERROR_MARKER + 'EACCES" >&2; exit 45; fi',
    'if [ ! -w "$PARENT" ]; then printf "' + SHELL_ERROR_MARKER + 'EACCES" >&2; exit 45; fi',
    'cat > "$TARGET"',
  ].join('\n');
}

function buildPowerShellWriteFromStdinScript(targetPath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${toPowerShellSingleQuoted(targetPath)}`,
    '$parent = Split-Path -Parent $target',
    `if (-not (Test-Path -LiteralPath $parent -PathType Container)) { [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}ENOENT'); exit 44 }`,
    'if (Test-Path -LiteralPath $target) {',
    '  $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop',
    `  if ($item.PSIsContainer) { [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}EISDIR'); exit 46 }`,
    '}',
    'try {',
    '  $inputStream = [Console]::OpenStandardInput()',
    '  $fileStream = [System.IO.File]::Open($target, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)',
    '  try {',
    '    $inputStream.CopyTo($fileStream)',
    '  } finally {',
    '    $fileStream.Dispose()',
    '    $inputStream.Dispose()',
    '  }',
    '} catch [System.UnauthorizedAccessException] {',
    `  [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}EACCES')`,
    '  exit 45',
    '}',
  ].join('\n');
}

function buildPosixCreateDirectoryScript(targetPath) {
  return [
    'set -euo pipefail',
    `TARGET=${toPosixSingleQuoted(targetPath)}`,
    'PARENT="$(dirname "$TARGET")"',
    'if [ ! -d "$PARENT" ]; then printf "' + SHELL_ERROR_MARKER + 'ENOENT" >&2; exit 44; fi',
    'if [ -e "$TARGET" ]; then printf "' + SHELL_ERROR_MARKER + 'EEXIST" >&2; exit 47; fi',
    'if [ ! -w "$PARENT" ]; then printf "' + SHELL_ERROR_MARKER + 'EACCES" >&2; exit 45; fi',
    'mkdir "$TARGET"',
  ].join('\n');
}

function buildPowerShellCreateDirectoryScript(targetPath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${toPowerShellSingleQuoted(targetPath)}`,
    '$parent = Split-Path -Parent $target',
    `if (-not (Test-Path -LiteralPath $parent -PathType Container)) { [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}ENOENT'); exit 44 }`,
    `if (Test-Path -LiteralPath $target) { [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}EEXIST'); exit 47 }`,
    'try {',
    '  New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null',
    '} catch [System.UnauthorizedAccessException] {',
    `  [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}EACCES')`,
    '  exit 45',
    '}',
  ].join('\n');
}

function buildPosixPathInfoScript(targetPath) {
  return [
    'set -euo pipefail',
    `TARGET=${toPosixSingleQuoted(targetPath)}`,
    'if [ ! -e "$TARGET" ]; then printf "' + SHELL_ERROR_MARKER + 'ENOENT" >&2; exit 44; fi',
    'if [ -d "$TARGET" ]; then printf "directory"; exit 0; fi',
    'if [ -f "$TARGET" ]; then printf "file"; exit 0; fi',
    'printf "other"',
  ].join('\n');
}

function buildPowerShellPathInfoScript(targetPath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${toPowerShellSingleQuoted(targetPath)}`,
    `if (-not (Test-Path -LiteralPath $target)) { [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}ENOENT'); exit 44 }`,
    '$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop',
    "if ($item.PSIsContainer) { [Console]::Out.Write('directory') } else { [Console]::Out.Write('file') }",
  ].join('\n');
}

function buildPosixDeletePathScript(targetPath) {
  return [
    'set -euo pipefail',
    `TARGET=${toPosixSingleQuoted(targetPath)}`,
    'if [ ! -e "$TARGET" ]; then printf "' + SHELL_ERROR_MARKER + 'ENOENT" >&2; exit 44; fi',
    'PARENT="$(dirname "$TARGET")"',
    'if [ ! -w "$PARENT" ]; then printf "' + SHELL_ERROR_MARKER + 'EACCES" >&2; exit 45; fi',
    'rm -rf -- "$TARGET"',
  ].join('\n');
}

function buildPowerShellDeletePathScript(targetPath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${toPowerShellSingleQuoted(targetPath)}`,
    `if (-not (Test-Path -LiteralPath $target)) { [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}ENOENT'); exit 44 }`,
    'try {',
    '  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop',
    '} catch [System.UnauthorizedAccessException] {',
    `  [Console]::Error.WriteLine('${SHELL_ERROR_MARKER}EACCES')`,
    '  exit 45',
    '}',
  ].join('\n');
}

function buildFileTreeFromShellOutput(stdout, rootPath) {
  const entries = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [encodedPath, itemType, sizeText, modifiedText, permText = ''] = line.split('\t');
      const relativePath = Buffer.from(encodedPath || '', 'base64').toString('utf8');
      const absolutePath = path.join(rootPath, relativePath);
      const modifiedEpoch = Number.parseInt(modifiedText, 10);
      const { permissions, permissionsRwx } = formatPermissions(permText);

      return {
        relativePath,
        absolutePath,
        itemType,
        size: Number.isFinite(Number(sizeText)) ? Number(sizeText) : 0,
        modified: Number.isFinite(modifiedEpoch) && modifiedEpoch > 0
          ? new Date(modifiedEpoch * 1000).toISOString()
          : null,
        permissions,
        permissionsRwx,
      };
    })
    .filter((entry) => entry.relativePath && entry.relativePath !== '.');

  return buildFileTreeFromEntries(entries);
}

function buildFileTreeFromEntries(entries) {
  const sortedEntries = [...entries].sort((left, right) => {
    const leftDepth = left.relativePath.split(path.sep).length;
    const rightDepth = right.relativePath.split(path.sep).length;

    if (leftDepth !== rightDepth) {
      return leftDepth - rightDepth;
    }

    if (left.itemType !== right.itemType) {
      return left.itemType === 'directory' ? -1 : 1;
    }

    return left.relativePath.localeCompare(right.relativePath);
  });

  const nodeByRelativePath = new Map();
  const rootNodes = [];

  for (const entry of sortedEntries) {
    const node = {
      name: path.basename(entry.relativePath),
      path: entry.absolutePath,
      type: entry.itemType,
      size: entry.size,
      modified: entry.modified,
      permissions: entry.permissions,
      permissionsRwx: entry.permissionsRwx,
    };

    if (entry.itemType === 'directory') {
      node.children = [];
    }

    nodeByRelativePath.set(entry.relativePath, node);

    const parentRelativePath = path.dirname(entry.relativePath);
    if (!parentRelativePath || parentRelativePath === '.') {
      rootNodes.push(node);
      continue;
    }

    const parentNode = nodeByRelativePath.get(parentRelativePath);
    if (parentNode) {
      if (!Array.isArray(parentNode.children)) {
        parentNode.children = [];
      }
      parentNode.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  sortFileTree(rootNodes);
  return rootNodes;
}

function sortFileTree(items) {
  items.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  for (const item of items) {
    if (Array.isArray(item.children) && item.children.length > 0) {
      sortFileTree(item.children);
    }
  }
}

async function getTerminalFileTree(dirPath, maxDepth = 3, showHidden = true, platform = os.platform()) {
  const script = platform === 'win32'
    ? buildPowerShellFileTreeScript(dirPath, maxDepth, showHidden)
    : buildPosixFileTreeScript(dirPath, maxDepth, showHidden);

  const { stdout } = await runShellScript({
    script,
    cwd: dirPath,
    platform,
  });

  return buildFileTreeFromShellOutput(stdout, dirPath);
}

async function getDirectFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
  const items = [];

  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!showHidden && entry.name.startsWith('.')) {
        continue;
      }

      if (PRUNED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }

      const itemPath = path.join(dirPath, entry.name);
      const item = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? 'directory' : 'file',
      };

      try {
        const stats = await fsPromises.stat(itemPath);
        item.size = stats.size;
        item.modified = stats.mtime.toISOString();
        const mode = stats.mode;
        const ownerPerm = (mode >> 6) & 7;
        const groupPerm = (mode >> 3) & 7;
        const otherPerm = mode & 7;
        item.permissions = ownerPerm.toString() + groupPerm.toString() + otherPerm.toString();
        item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
      } catch {
        item.size = 0;
        item.modified = null;
        item.permissions = '';
        item.permissionsRwx = '';
      }

      if (entry.isDirectory() && currentDepth < maxDepth) {
        try {
          await fsPromises.access(item.path);
          item.children = await getDirectFileTree(item.path, maxDepth, currentDepth + 1, showHidden);
        } catch {
          item.children = [];
        }
      }

      items.push(item);
    }
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') {
      console.error('Error reading directory:', error);
    }
  }

  sortFileTree(items);
  return items;
}

async function readTextFileDirect(targetPath) {
  return fsPromises.readFile(targetPath, 'utf8');
}

async function readBinaryFileDirect(targetPath) {
  return fsPromises.readFile(targetPath);
}

async function writeTextFileDirect(targetPath, content) {
  await fsPromises.writeFile(targetPath, content, 'utf8');
}

async function createDirectoryDirect(targetPath) {
  await fsPromises.mkdir(targetPath, { recursive: false });
}

async function getPathInfoDirect(targetPath) {
  const stats = await fsPromises.stat(targetPath);
  return {
    exists: true,
    isDirectory: stats.isDirectory(),
    type: stats.isDirectory() ? 'directory' : (stats.isFile() ? 'file' : 'other'),
  };
}

async function deletePathDirect(targetPath) {
  await fsPromises.rm(targetPath, { recursive: true, force: false });
}

async function readFileViaTerminal(targetPath, platform = os.platform()) {
  const script = platform === 'win32'
    ? buildPowerShellReadBase64Script(targetPath)
    : buildPosixReadBase64Script(targetPath);
  const { stdout } = await runShellScript({
    script,
    cwd: os.homedir(),
    platform,
  });
  return decodeShellBase64(stdout);
}

async function writeFileViaTerminal(targetPath, content, platform = os.platform()) {
  const script = platform === 'win32'
    ? buildPowerShellWriteFromStdinScript(targetPath)
    : buildPosixWriteFromStdinScript(targetPath);

  await runShellScript({
    script,
    cwd: os.homedir(),
    platform,
    input: Buffer.from(String(content), 'utf8'),
  });
}

async function createDirectoryViaTerminal(targetPath, platform = os.platform()) {
  const script = platform === 'win32'
    ? buildPowerShellCreateDirectoryScript(targetPath)
    : buildPosixCreateDirectoryScript(targetPath);

  await runShellScript({
    script,
    cwd: os.homedir(),
    platform,
  });
}

async function getPathInfoViaTerminal(targetPath, platform = os.platform()) {
  const script = platform === 'win32'
    ? buildPowerShellPathInfoScript(targetPath)
    : buildPosixPathInfoScript(targetPath);

  const { stdout } = await runShellScript({
    script,
    cwd: os.homedir(),
    platform,
  });

  const type = String(stdout || '').trim() || 'other';
  return {
    exists: true,
    isDirectory: type === 'directory',
    type,
  };
}

async function deletePathViaTerminal(targetPath, platform = os.platform()) {
  const script = platform === 'win32'
    ? buildPowerShellDeletePathScript(targetPath)
    : buildPosixDeletePathScript(targetPath);

  await runShellScript({
    script,
    cwd: os.homedir(),
    platform,
  });
}

function resolveOperationMode(requestedMode, platform) {
  return resolveEffectiveFileAccessMode(
    requestedMode || process.env.OPENWORK_FILE_ACCESS_MODE,
    platform,
  );
}

export async function listProjectFileTree(dirPath, options = {}) {
  const {
    requestedMode,
    maxDepth = 3,
    showHidden = true,
    platform = os.platform(),
  } = options;

  const effectiveMode = resolveOperationMode(requestedMode, platform);

  const items = effectiveMode === FILE_ACCESS_MODES.TERMINAL_FIRST
    ? await getTerminalFileTree(dirPath, maxDepth, showHidden, platform)
    : await getDirectFileTree(dirPath, maxDepth, 0, showHidden);

  return {
    mode: effectiveMode,
    items,
  };
}

export async function readTextFileWithMode(targetPath, options = {}) {
  const { requestedMode, platform = os.platform() } = options;
  const effectiveMode = resolveOperationMode(requestedMode, platform);

  const content = effectiveMode === FILE_ACCESS_MODES.TERMINAL_FIRST
    ? (await readFileViaTerminal(targetPath, platform)).toString('utf8')
    : await readTextFileDirect(targetPath);

  return {
    mode: effectiveMode,
    content,
  };
}

export async function readBinaryFileWithMode(targetPath, options = {}) {
  const { requestedMode, platform = os.platform() } = options;
  const effectiveMode = resolveOperationMode(requestedMode, platform);

  const content = effectiveMode === FILE_ACCESS_MODES.TERMINAL_FIRST
    ? await readFileViaTerminal(targetPath, platform)
    : await readBinaryFileDirect(targetPath);

  return {
    mode: effectiveMode,
    content,
  };
}

export async function writeTextFileWithMode(targetPath, content, options = {}) {
  const { requestedMode, platform = os.platform() } = options;
  const effectiveMode = resolveOperationMode(requestedMode, platform);

  if (effectiveMode === FILE_ACCESS_MODES.TERMINAL_FIRST) {
    await writeFileViaTerminal(targetPath, content, platform);
  } else {
    await writeTextFileDirect(targetPath, content);
  }

  return {
    mode: effectiveMode,
  };
}

export async function createDirectoryWithMode(targetPath, options = {}) {
  const { requestedMode, platform = os.platform() } = options;
  const effectiveMode = resolveOperationMode(requestedMode, platform);

  if (effectiveMode === FILE_ACCESS_MODES.TERMINAL_FIRST) {
    await createDirectoryViaTerminal(targetPath, platform);
  } else {
    await createDirectoryDirect(targetPath);
  }

  return {
    mode: effectiveMode,
  };
}

export async function getPathInfoWithMode(targetPath, options = {}) {
  const { requestedMode, platform = os.platform() } = options;
  const effectiveMode = resolveOperationMode(requestedMode, platform);

  const info = effectiveMode === FILE_ACCESS_MODES.TERMINAL_FIRST
    ? await getPathInfoViaTerminal(targetPath, platform)
    : await getPathInfoDirect(targetPath);

  return {
    mode: effectiveMode,
    ...info,
  };
}

export async function deletePathWithMode(targetPath, options = {}) {
  const { requestedMode, platform = os.platform() } = options;
  const effectiveMode = resolveOperationMode(requestedMode, platform);

  if (effectiveMode === FILE_ACCESS_MODES.TERMINAL_FIRST) {
    await deletePathViaTerminal(targetPath, platform);
  } else {
    await deletePathDirect(targetPath);
  }

  return {
    mode: effectiveMode,
  };
}

export async function pathExists(targetPath) {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch (error) {
    if (isNoSuchFileError(error)) {
      return false;
    }
    throw error;
  }
}

export async function ensureReadableDirectory(targetPath) {
  const stats = await fsPromises.stat(targetPath);
  if (!stats.isDirectory()) {
    throw createOperationError('ENOENT', 'Directory not found');
  }
  return stats;
}
