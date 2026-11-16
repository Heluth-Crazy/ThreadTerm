/* Files a viewer has nothing to show for: archives, packages and programs an agent builds (a .jar, a .zip, an .exe).
   What the user wants from one is the folder it sits in, so file links to them offer that next to the link. */

const PACKAGE_EXTENSIONS = new Set([
  // Java and Android
  '.jar', '.war', '.ear', '.aar', '.apk', '.aab', '.class',
  // Archives
  '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst',
  // Language and editor packages
  '.whl', '.egg', '.nupkg', '.gem', '.vsix', '.crx', '.xpi',
  // Installers, programs and disk images
  '.exe', '.msi', '.msix', '.appx', '.dll', '.so', '.dylib', '.deb', '.rpm', '.dmg', '.pkg', '.iso', '.appimage', '.wasm',
]);

/** An archive, package or program, judged by its extension. */
export function isPackageFile(path: string | undefined): boolean {
  if (!path) return false;
  const name = path.split(/[\\/]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && PACKAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** The runtime refused to read the file as text (`binary_file`), whatever its extension. */
export function isBinaryFileError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const detail = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  return code === 'binary_file' || /\bbinary_file\b/.test(detail);
}
