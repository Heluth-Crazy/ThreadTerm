/*
 * The Chat composer's "/" menu (owner 2026-11-26: take T3 Code's command menu as the reference). One list of what
 * "/" can do here: ThreadTerm's own commands, the agent's commands, and the agent's skills. A query ranks names
 * that start with it first, then names with a word that starts with it ("/rev" finds code-review), then names and
 * descriptions that contain it, then names that contain its letters in order.
 */
import type { ChatSkill, ChatSlashCommand } from '@threadterm/protocol';

export type SlashSource = 'app' | 'agent' | 'skill';
export interface SlashItem {
  /** Stable across renders: the source and the name. */
  id: string;
  source: SlashSource;
  /** Without the leading slash. */
  name: string;
  description?: string;
  /** For a skill: the provider's own text invocation, written into the composer when picked. */
  invocation?: string;
}

const bare = (name: string) => name.replace(/^\//, '');

/** ThreadTerm's commands first, then the agent's, then its skills; a skill the agent already lists as a command is not repeated. */
export function slashItems(app: readonly ChatSlashCommand[], agent: readonly ChatSlashCommand[], skills: readonly ChatSkill[] = []): SlashItem[] {
  const seen = new Set<string>();
  const out: SlashItem[] = [];
  const add = (item: SlashItem) => { const key = item.name.toLowerCase(); if (!item.name || seen.has(key)) return; seen.add(key); out.push(item); };
  for (const command of app) add({ id: `app:${bare(command.name)}`, source: 'app', name: bare(command.name), description: command.description });
  for (const command of agent) add({ id: `agent:${bare(command.name)}`, source: 'agent', name: bare(command.name), description: command.description });
  for (const skill of skills) {
    const name = bare(skill.name), invocation = skill.invocation.trim();
    if (!name || /\s/.test(name) || !invocation || /[\r\n]/.test(invocation)) continue;
    // A skill invoked as "/name" is the same thing as the command "/name".
    if (seen.has(bare(invocation).toLowerCase())) continue;
    add({ id: `skill:${name}`, source: 'skill', name, description: skill.description, invocation });
  }
  return out;
}

/** Lower is better; undefined when the item does not match at all. */
export function slashScore(item: Pick<SlashItem, 'name' | 'description'>, query: string): number | undefined {
  const needle = bare(query).trim().toLowerCase();
  if (!needle) return 0;
  const name = item.name.toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.split(/[-_:./]/).some(word => word.startsWith(needle))) return 2;
  if (name.includes(needle)) return 3;
  if (item.description?.toLowerCase().includes(needle)) return 5;
  // The query's letters in order inside the name ("/cr" → code-review); tighter spans rank higher.
  let at = -1, first = -1;
  for (const letter of needle) {
    at = name.indexOf(letter, at + 1);
    if (at < 0) return undefined;
    if (first < 0) first = at;
  }
  return 8 + (at - first + 1 - needle.length) / 100;
}

/** The items that match, best first; ties keep their order (ThreadTerm, agent, skills). */
export function rankSlash(items: readonly SlashItem[], query: string): SlashItem[] {
  return items
    .map((item, index) => ({ item, index, score: slashScore(item, query) }))
    .filter((row): row is { item: SlashItem; index: number; score: number } => row.score !== undefined)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(row => row.item);
}

/** What the composer holds after picking a skill: its invocation, ready for the request. */
export const skillText = (item: SlashItem) => `${item.invocation ?? `/${item.name}`} `;

/** The heading over each source when the menu lists everything ("/" alone). */
export function slashSourceLabel(source: SlashSource, zh: boolean): string {
  if (source === 'app') return 'ThreadTerm';
  if (source === 'agent') return zh ? '智能体命令' : 'Agent commands';
  return zh ? '技能' : 'Skills';
}
