import type { QuickLaunchCommand, QuickLaunchRepoEntry, QuickLaunchRepoLaunchFields } from '@threadterm/protocol';

export type RepoDiffField = 'command'|'shell'|'cwd'|'kind'|'env'|'previewUrl';
export type RepoEnvDiffKind = 'added'|'removed'|'changed';
export type RepoDiff =
 | { field:Exclude<RepoDiffField,'env'>; before:string; after:string }
 | { field:'env'; name:string; change:RepoEnvDiffKind; before?:string; after?:string };

type RepoEnv = QuickLaunchRepoLaunchFields['env'][number] | QuickLaunchRepoEntry['env'][number];
type RepoLaunchEntry = { command:string; shell:QuickLaunchRepoEntry['shell']; cwd:string; kind:QuickLaunchRepoEntry['kind']; env:RepoEnv[]; previewUrl?:string };

/** Render untrusted file content so line breaks and invisible code points cannot impersonate another field. */
export function visibleQuoted(value:string|undefined):string {
 const text = value ?? '';
 let escaped = '';
 for (const character of text) {
  const code = character.codePointAt(0)!;
  if (character === '\\') escaped += '\\\\';
  else if (character === '"') escaped += '\\"';
  else if (character === '\n') escaped += '\\n';
  else if (character === '\r') escaped += '\\r';
  else if (character === '\t') escaped += '\\t';
  else if (isInvisible(character, code)) escaped += code <= 0xffff ? `\\u${code.toString(16).toUpperCase().padStart(4,'0')}` : `\\u{${code.toString(16).toUpperCase()}}`;
  else escaped += character;
 }
 return `"${escaped}"`;
}

function isInvisible(character:string, code:number):boolean {
 return (character !== ' ' && /\p{Cc}|\p{Cf}|\p{Cs}|\p{Z}/u.test(character))
  || code === 0x034f || code === 0x115f || code === 0x1160 || code === 0x17b4 || code === 0x17b5
  || code === 0x2800 || code === 0x3164 || code === 0xffa0
  || (code >= 0x180b && code <= 0x180f) || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

/** A secret is structurally distinct from any literal value, including a string resembling a marker. */
export function repoEnvValue(env:RepoEnv):string {
 return env.secret ? 'secret (local value)' : `value ${visibleQuoted(env.value)}`;
}

export function repoFieldValue(entry:RepoLaunchEntry, field:RepoDiffField):string {
 if (field === 'env') return entry.env.map(env => `${env.name}: ${repoEnvValue(env)}`).join('\n');
 return visibleQuoted(entry[field]);
}

/** Field-level review of the last accepted launch fields against current repo content. Env variables are compared by name. */
export function repoDiff(entry:Pick<QuickLaunchRepoEntry,'command'|'shell'|'cwd'|'kind'|'env'|'previewUrl'|'accepted'>):RepoDiff[] {
 if (!entry.accepted) return [];
 const fields:Exclude<RepoDiffField,'env'>[] = ['command','shell','cwd','kind','previewUrl'];
 const scalar = fields.flatMap(field => {
  const beforeRaw = entry.accepted![field] ?? '', afterRaw = entry[field] ?? '';
  return beforeRaw === afterRaw ? [] : [{ field, before:visibleQuoted(beforeRaw), after:visibleQuoted(afterRaw) } satisfies RepoDiff];
 });
 const accepted = new Map(entry.accepted.env.map(env => [env.name, env]));
 const current = new Map(entry.env.map(env => [env.name, env]));
 const names = [...new Set([...accepted.keys(), ...current.keys()])].sort((left,right) => left.localeCompare(right));
 const env:RepoDiff[] = names.flatMap<RepoDiff>(name => {
  const before = accepted.get(name), after = current.get(name);
  if (!before) return [{field:'env' as const, name, change:'added' as const, after:repoEnvValue(after!)}];
  if (!after) return [{field:'env' as const, name, change:'removed' as const, before:repoEnvValue(before)}];
  const unchanged = Boolean(before.secret) === Boolean(after.secret) && (Boolean(before.secret) || before.value === after.value);
  return unchanged ? [] : [{field:'env' as const, name, change:'changed' as const, before:repoEnvValue(before), after:repoEnvValue(after)}];
 });
 return [...scalar, ...env];
}

export function repoBadges(entry:Pick<QuickLaunchRepoEntry,'changed'|'missingSecrets'>):{changed:boolean;missing:string[]} {
 return { changed:entry.changed, missing:[...entry.missingSecrets] };
}

/** New/detected/local entries default local; only an entry already read from the repo defaults to shared storage. */
export function editorStorage(command?:QuickLaunchCommand, repo?:QuickLaunchRepoEntry):'local'|'repo' {
 return repo ? 'repo' : 'local';
}

export type PendingRepoMove = { direction:'toRepo'|'toLocal'; launch:boolean };
export const pendingRepoMove = (direction:PendingRepoMove['direction'], launch:boolean):PendingRepoMove => ({direction, launch});
export function storageMoveSources(saved?:Pick<QuickLaunchCommand,'id'|'revision'>, repo?:Pick<QuickLaunchRepoEntry,'id'>, fingerprint?:string, root?:string) {
 return {localSource:saved ? {id:saved.id,revision:saved.revision} : undefined, repoSource:repo && fingerprint && root ? {id:repo.id,fingerprint,cwd:root} : undefined};
}
export const repoCommandId = (id:string) => `repo:${id}`;
