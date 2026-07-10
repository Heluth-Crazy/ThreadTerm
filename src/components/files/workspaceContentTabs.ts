export function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

export function workspaceFileTabId(rootPath: string, path: string): string {
  return `file:${encodeURIComponent(rootPath)}:${encodeURIComponent(path)}`;
}

export function workspaceDiffTabId(repositoryRoot: string, path: string): string {
  return `diff:${encodeURIComponent(repositoryRoot)}:${encodeURIComponent(path)}`;
}
