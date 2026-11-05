import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const MAX_RELATIVE_PATH_BYTES = 4096;

const fail = (code: string): never => { throw new Error(code); };

/** A display-only path: Node's extended Windows prefix is never sent to a renderer. */
export function displayPath(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '');
}

export async function canonicalPath(path: string): Promise<string> {
  // Node realpath is the internal operational identity and normally returns a plain Windows path.
  // Namespace conversion, when a wire contract requires it, belongs at that boundary.
  return realpath(path).catch(() => fail('file_not_found'));
}

export function isContained(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Reject non-portable, ambiguous Windows names even when running tests on another OS. */
export function validateReferencePath(path: string, allowEmpty = false): string[] {
  if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > MAX_RELATIVE_PATH_BYTES || path.includes('\0')) fail('invalid_path');
  const parts = path.split('/');
  if ((!allowEmpty && !path) || parts.some(part => !validPart(part))) fail('invalid_path');
  return parts;
}

function validPart(part: string): boolean {
  if (!part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255 || part.endsWith('.') || part.endsWith(' ')) return false;
  if (/[<>:"|?*\\/\x00-\x1f]/.test(part)) return false;
  const stem = part.split('.')[0]!.toUpperCase();
  return !['CON', 'PRN', 'AUX', 'NUL'].includes(stem) && !/^(COM|LPT)[1-9]$/.test(stem);
}

export async function containedExisting(root: string, reference: string): Promise<string> {
  validateScopedReferencePath(reference);
  const canonicalRoot = await canonicalPath(root);
  const candidate = await realpath(resolve(canonicalRoot, reference)).catch(() => fail('file_not_found'));
  if (!isContained(canonicalRoot, candidate)) fail('path_escape');
  return candidate;
}

/** Match workspace_services::scoped_path for already-existing file operations. */
function validateScopedReferencePath(path:string):void {
  if(typeof path!=='string'||path.includes('\0')||isAbsolute(path))fail('invalid_path');
  if(process.platform==='win32'&&/^[a-z]:/i.test(path))fail('invalid_path');
  const parts=path.split(process.platform==='win32'?/[\\/]+/:/\/+/);
  if(parts.includes('..'))fail('invalid_path');
}

export type ContainedTarget = {
  root: string;
  parent: string;
  path: string;
  createdParents: number;
};

/** Resolve a target whose last segment may not yet exist; links in every parent are checked. */
export async function containedTarget(root: string, reference: string, createParents: boolean): Promise<string> {
  return (await containedTargetDetails(root, reference, createParents)).path;
}

/** The detailed form lets mutation callers avoid claiming "no effect" after parent creation. */
export async function containedTargetDetails(root: string, reference: string, createParents: boolean): Promise<ContainedTarget> {
  const parts = validateReferencePath(reference);
  const canonicalRoot = await canonicalPath(root);
  const parentParts = parts.slice(0, -1);
  let parent = canonicalRoot;
  let createdParents = 0;
  for (const part of parentParts) {
    const next = resolve(parent, part);
    try {
      parent = await realpath(next);
    } catch {
      if (!createParents) fail('parent_missing');
      try {
        await mkdir(next); // one component at a time prevents mkdir recursive link races
        createdParents++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      parent = await realpath(next).catch(() => fail('path_escape'));
    }
    if (!isContained(canonicalRoot, parent)) fail('path_escape');
    const meta = await lstat(parent).catch(() => fail('parent_missing'));
    if (!meta.isDirectory() || meta.isSymbolicLink()) fail('parent_not_directory');
  }
  const target = resolve(parent, parts.at(-1)!);
  if (!isContained(canonicalRoot, target)) fail('path_escape');
  return {root: canonicalRoot, parent, path: target, createdParents};
}

/** Recheck a lexical target's parent immediately before a rename/delete effect. */
export async function recheckContainedTarget(root: string, target: string): Promise<void> {
  const canonicalRoot = await canonicalPath(root);
  const expectedParent = dirname(target);
  const currentParent = await realpath(expectedParent).catch(() => fail('path_escape'));
  if (!isContained(canonicalRoot, currentParent) || relative(expectedParent, currentParent) !== '') fail('path_escape');
  const meta = await lstat(currentParent).catch(() => fail('parent_missing'));
  if (!meta.isDirectory() || meta.isSymbolicLink()) fail('parent_not_directory');
}
