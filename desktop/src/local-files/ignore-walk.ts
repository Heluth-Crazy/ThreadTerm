import { lstat, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ignore from 'ignore';
import { readBoundedFile } from './bounded-read.js';

const MAX_IGNORE_BYTES = 1024 * 1024;
const MAX_WALK_ENTRIES = 100_000;
type Matcher = ReturnType<typeof ignore>;
type Layer = {base: string; matcher: Matcher};

class IgnoreRules {
  constructor(
    private readonly ignoreFiles: readonly Layer[],
    private readonly gitIgnoreFiles: readonly Layer[],
    private readonly gitExcludes: readonly Layer[],
    private readonly globalExclude?: Layer,
  ) {}

  static async create(root: string): Promise<IgnoreRules> {
    let rules = new IgnoreRules([], [], [], await globalExclude(root));
    const ancestors: string[] = [];
    for (let current = dirname(root);;) {
      ancestors.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const ancestor of ancestors.reverse()) rules = await rules.addDirectory(ancestor);
    return rules;
  }

  async addDirectory(directory: string): Promise<IgnoreRules> {
    const localIgnore = await ruleFile(directory, join(directory, '.ignore'));
    const gitIgnore = await ruleFile(directory, join(directory, '.gitignore'));
    const excludePath = await repositoryExcludePath(directory);
    const gitExclude = excludePath ? await ruleFile(directory, excludePath) : undefined;
    return new IgnoreRules(
      localIgnore ? [...this.ignoreFiles, localIgnore] : this.ignoreFiles,
      gitIgnore ? [...this.gitIgnoreFiles, gitIgnore] : this.gitIgnoreFiles,
      gitExclude ? [...this.gitExcludes, gitExclude] : this.gitExcludes,
      this.globalExclude,
    );
  }

  ignored(path: string, directory: boolean): boolean {
    for (const layers of [this.ignoreFiles, this.gitIgnoreFiles, this.gitExcludes]) {
      const result = matchLayers(layers, path, directory);
      if (result !== undefined) return result;
    }
    if (this.globalExclude) {
      const result = matchLayers([this.globalExclude], path, directory);
      if (result !== undefined) return result;
    }
    return false;
  }
}

export type WalkedFile = {path: string; absolute: string};
export type WalkState = {truncated: boolean};

export function streamProjectFiles(root: string, deadline: number, maximum = Number.MAX_SAFE_INTEGER): {items: AsyncIterable<WalkedFile>; state: WalkState} {
  const state: WalkState = {truncated:false};
  let count = 0;
  let visited = 0;

  const items = (async function*(): AsyncGenerator<WalkedFile> {
    const parentRules = await IgnoreRules.create(root);
    async function* visit(directory: string, inherited: IgnoreRules): AsyncGenerator<WalkedFile> {
      if (Date.now() > deadline) { state.truncated=true; return; }
      const rules = await inherited.addDirectory(directory);
      const entries = [];
      const handle = await opendir(directory).catch(() => undefined);
      if (!handle) return;
      for await (const entry of handle) {
        if (Date.now() > deadline || visited >= MAX_WALK_ENTRIES) { state.truncated=true; break; }
        visited++;
        entries.push(entry);
      }
      if (state.truncated) return;
      entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const item of entries) {
        if (state.truncated) return;
        if (Date.now() > deadline) { state.truncated=true; return; }
        if (item.name === '.git') continue;
        const absolute = join(directory, item.name);
        const metadata = await lstat(absolute).catch(() => undefined);
        if (!metadata || metadata.isSymbolicLink()) continue;
        const directoryEntry = metadata.isDirectory();
        if (!directoryEntry && !metadata.isFile()) continue;
        if (rules.ignored(absolute, directoryEntry)) continue;
        if (directoryEntry) {
          yield* visit(absolute, rules);
        } else {
          if (count >= maximum) { state.truncated=true; return; }
          count++;
          yield {path: slash(relative(root, absolute)), absolute};
        }
      }
    }
    yield* visit(root,parentRules);
  })();
  return {items,state};
}

/** Runtime-compatible, bounded walk with no Git/helper subprocess. */
export async function walkProjectFiles(root: string, deadline: number, maximum: number): Promise<{items: WalkedFile[]; truncated: boolean}> {
  const walked=streamProjectFiles(root,deadline,maximum);
  const items:WalkedFile[]=[];
  for await(const item of walked.items)items.push(item);
  return {items,truncated:walked.state.truncated};
}

function slash(path: string): string {
  return path.replace(/\\/g, '/');
}

function matchLayers(layers: readonly Layer[], absolute: string, directory: boolean): boolean | undefined {
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!;
    const candidate = slash(relative(layer.base, absolute));
    if (!candidate || candidate === '..' || candidate.startsWith('../')) continue;
    const result = layer.matcher.test(directory ? `${candidate}/` : candidate);
    if (result.ignored) return true;
    if (result.unignored) return false;
  }
  return undefined;
}

async function ruleFile(base: string, path: string): Promise<Layer | undefined> {
  try {
    const contents = (await readBoundedFile(path, MAX_IGNORE_BYTES, 'ignore_file_too_large')).toString('utf8');
    return {base, matcher: ignore({ignorecase: false}).add(contents)};
  } catch {
    return undefined;
  }
}

async function repositoryExcludePath(directory: string): Promise<string | undefined> {
  const dotGit = join(directory, '.git');
  const metadata = await lstat(dotGit).catch(() => undefined);
  if (!metadata) return undefined;
  if (metadata.isDirectory()) return join(dotGit, 'info', 'exclude');
  if (!metadata.isFile()) return undefined;
  try {
    const descriptor = (await readBoundedFile(dotGit, 64 * 1024, 'gitdir_file_too_large')).toString('utf8');
    const first = descriptor.split(/\r?\n/, 1)[0] ?? '';
    if (!first.startsWith('gitdir: ')) return undefined;
    const rawGitDirectory = first.slice('gitdir: '.length).trim();
    if (!rawGitDirectory) return undefined;
    const gitDirectory = isAbsolute(rawGitDirectory) ? rawGitDirectory : resolve(directory, rawGitDirectory);
    const commonFile = join(gitDirectory, 'commondir');
    const common = await readBoundedFile(commonFile, 64 * 1024, 'commondir_file_too_large').catch(() => undefined);
    if (!common) return join(gitDirectory, 'info', 'exclude');
    const rawCommon = common.toString('utf8').split(/\r?\n/, 1)[0]?.trim();
    if (!rawCommon) return undefined;
    const commonDirectory = isAbsolute(rawCommon) ? rawCommon : resolve(gitDirectory, rawCommon);
    return join(commonDirectory, 'info', 'exclude');
  } catch {
    return undefined;
  }
}

async function globalExclude(root: string): Promise<Layer | undefined> {
  const path = await globalExcludePath();
  return path ? ruleFile(root, path) : undefined;
}

async function globalExcludePath(): Promise<string | undefined> {
  const environment = process.env;
  const home = environment.HOME || environment.USERPROFILE || homedir();
  const xdg = environment.XDG_CONFIG_HOME || (home ? join(home, '.config') : undefined);
  const configuredGlobal = environment.GIT_CONFIG_GLOBAL;
  const configs = configuredGlobal
    ? [configuredGlobal]
    : [home ? join(home, '.gitconfig') : undefined, xdg ? join(xdg, 'git', 'config') : undefined];
  configs.push(environment.GIT_CONFIG_SYSTEM || (process.platform === 'win32' ? undefined : '/etc/gitconfig'));
  for (const config of configs) {
    if (!config) continue;
    const contents = await readBoundedFile(config, MAX_IGNORE_BYTES, 'git_config_too_large').catch(() => undefined);
    if (!contents) continue;
    const match = /^\s*excludesfile\s*=\s*"?\s*(\S+?)\s*"?\s*$/im.exec(contents.toString('utf8'));
    if (match?.[1]) return expandHome(match[1], home);
  }
  return xdg ? join(xdg, 'git', 'ignore') : undefined;
}

function expandHome(path: string, home: string): string {
  return home ? path.replaceAll('~', home) : path;
}
