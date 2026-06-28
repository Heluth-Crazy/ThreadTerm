/**
 * Shared types + presentation helpers for the workspace file explorer.
 *
 * `DirEntry` mirrors the Rust `files::DirEntry` (camelCase via serde), returned
 * by the `read_directory` command. Listing is lazy — one directory level per
 * call — so the tree only fetches a child folder when the user expands it.
 */

export interface DirEntry {
  /** Final path component (display name). */
  name: string;
  /** Absolute path; pass straight back to `read_directory` to expand. */
  path: string;
  isDir: boolean;
  /** Dot-file / dot-dir — de-emphasised in the tree. */
  isHidden: boolean;
}

/**
 * Map a file name to a Tailwind text-colour class so the tree distinguishes
 * file types at a glance (VS Code-style). Unknown extensions fall back to the
 * muted foreground. Directories are coloured by the caller, not here.
 */
const EXT_COLOR: Record<string, string> = {
  ts: 'text-blue-400',
  tsx: 'text-blue-400',
  js: 'text-amber-300',
  jsx: 'text-amber-300',
  mjs: 'text-amber-300',
  cjs: 'text-amber-300',
  rs: 'text-orange-400',
  go: 'text-cyan-300',
  py: 'text-emerald-300',
  json: 'text-yellow-300',
  jsonc: 'text-yellow-300',
  md: 'text-slate-300',
  mdx: 'text-slate-300',
  txt: 'text-slate-300',
  css: 'text-pink-400',
  scss: 'text-pink-400',
  html: 'text-orange-300',
  toml: 'text-stone-300',
  yaml: 'text-stone-300',
  yml: 'text-stone-300',
  lock: 'text-stone-400',
  png: 'text-violet-300',
  jpg: 'text-violet-300',
  jpeg: 'text-violet-300',
  gif: 'text-violet-300',
  svg: 'text-violet-300',
  webp: 'text-violet-300',
  ico: 'text-violet-300',
  sh: 'text-green-400',
  zsh: 'text-green-400',
  bash: 'text-green-400',
};

export function fileColorClass(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'text-muted-foreground';
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_COLOR[ext] ?? 'text-muted-foreground';
}

/** Last path component, tolerant of both `/` and `\` separators. */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
