type NativeFilePathBridge = { getPathForFile?: (file: File) => string };

/** Returns paths only for native Files supplied by a drop/input event. */
export function groupDropFilePaths(files: Iterable<File>, getPathForFile?: (file: File) => string): string[] {
 if (typeof getPathForFile !== 'function') return [];
 const paths: string[] = [];
 for (const file of files) {
  try {
   const path = getPathForFile(file);
   if (typeof path === 'string' && path) paths.push(path);
  } catch {
   // Synthetic, detached, and non-disk browser Files have no native path.
  }
 }
 return paths;
}

/** Electron capability is intentionally optional for browser/test renderers. */
export function groupDropPaths(transfer: Pick<DataTransfer, 'files'> | undefined): string[] {
 const native = window.threadterm as typeof window.threadterm & NativeFilePathBridge;
 return groupDropFilePaths(transfer?.files ?? [], native.getPathForFile);
}
