/** Normalize absolute/relative path under a workspace root to a relative key. */

export function relativeFromRoot(rootPath: string, absoluteOrRelative: string): string {
  const root = rootPath.replace(/[\\/]+$/, '');
  const path = absoluteOrRelative;
  const normalizedRoot = root.replace(/\\/g, '/');
  const normalizedPath = path.replace(/\\/g, '/');
  if (normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + '/')) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  if (normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + '\\')) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function joinRootRelative(rootPath: string, relativePath: string): string {
  const root = rootPath.replace(/[\\/]+$/, '');
  const rel = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel) return root;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root}${sep}${rel.replace(/\//g, sep)}`;
}

export function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}
