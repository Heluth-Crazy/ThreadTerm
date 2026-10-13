// Composer option helpers (task 10-11-chat-parity C2).
//
// Pure, total functions: option classification, chip/menu labels, the
// narrow-width overflow fold, model search/grouping and the virtual row window.
// No DOM, no timers, no provider-name branching - the shapes come from the
// additive `ChatSessionOption` metadata the runtime assigns in C1.

import type { ChatSessionChoice, ChatSessionOption } from "@threadterm/protocol";

export type OptionCategory = "mode" | "model" | "thinking" | "other";
export type ComposerCopy = (en: string, zh: string) => string;

/** Known provider values, localized like the legacy MODE_LABELS/THINKING_LABELS. */
const VALUE_LABELS: Record<string, [string, string]> = {
  default: ["Default", "默认"],
  plan: ["Plan", "规划"],
  onrequest: ["Ask as needed", "按需询问"],
  never: ["Never ask", "从不询问"],
  onfailure: ["On failure", "失败时询问"],
  untrusted: ["Untrusted", "不受信任的"],
  readonly: ["Read only", "只读"],
  workspacewrite: ["Workspace write", "工作区可写"],
  dangerfullaccess: ["Full access", "完全访问"],
  auto: ["Auto", "自动"],
  yolo: ["Full access", "完全访问"],
  acceptedits: ["Accept edits", "接受编辑"],
  dontask: ["Don't ask", "不问"],
  bypasspermissions: ["Bypass", "跳过权限"],
  off: ["Off", "关"],
  none: ["Off", "关"],
  minimal: ["Minimal", "最低"],
  low: ["Low", "低"],
  on: ["On", "开"],
  medium: ["Medium", "中"],
  high: ["High", "高"],
  xhigh: ["Xhigh", "超高"],
  max: ["Max", "Max"],
  ultra: ["Ultra", "Ultra"],
  user: ["User", "用户"],
  autoreview: ["Auto review", "自动审查"],
  guardiansubagent: ["Guardian subagent", "守护子代理"],
  all: ["All", "全部"],
  oneatatime: ["One at a time", "逐个处理"],
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Category from the C1 metadata, with the legacy regex fallback for old rows. */
export function optionCategory(option: ChatSessionOption): OptionCategory {
  if (option.category) return option.category;
  const id = option.id.toLowerCase();
  const name = option.name.toLowerCase();
  if (id.includes("model") || name.includes("model")) return "model";
  if (id.includes("think") || id.includes("reason") || name.includes("think") || name.includes("reason")) return "thinking";
  if (id.includes("mode") || name.includes("mode")) return "mode";
  return "other";
}

/** Booleans use the two-value contract `true`/`false` (or On/Off legacy rows). */
export function isBooleanOption(option: ChatSessionOption): boolean {
  if (option.kind === "boolean") return true;
  return option.choices.length === 2 && option.choices.every(choice => /^(true|false|on|off)$/i.test(choice.value));
}

export function currentChoiceName(option: ChatSessionOption): string {
  return option.choices.find(choice => choice.value === option.value)?.name ?? option.value;
}

/** A choice's display text: known provider values localize, everything else keeps the provider's own name. */
export function choiceText(option: ChatSessionOption, choice: ChatSessionChoice, zh: boolean): string {
  if (optionCategory(option) === "model") return choice.name || choice.value;
  const known = VALUE_LABELS[normalize(choice.value)];
  return known ? (zh ? known[1] : known[0]) : choice.name || choice.value;
}

/** The current value as a short chip label. */
export function chipValueText(option: ChatSessionOption, zh: boolean): string {
  const choice = option.choices.find(entry => entry.value === option.value) ?? { value: option.value, name: option.value };
  return choiceText(option, choice, zh);
}

export function booleanText(value: string, copy: ComposerCopy): string {
  return value === "true" || value.toLowerCase() === "on" ? copy("On", "开") : copy("Off", "关");
}

/** The thinking chip drops a provider's redundant "thinking" prefix. */
export function thinkingChipText(option: ChatSessionOption, zh: boolean): string {
  return chipValueText(option, zh).replace(/^thinking\s+/i, "") || option.value;
}

/** Localized option title. Unknown provider options keep the name the adapter sent. */
export function optionTitle(option: ChatSessionOption, copy: ComposerCopy): string {
  const id = option.id.toLowerCase();
  if (id === "model") return copy("Model", "模型");
  if (id.includes("think")) return copy("Thinking level", "思考程度");
  if (id === "collaboration") return copy("Collaboration", "协作模式");
  if (id === "approvalpolicy" || (id === "mode" && /^approval policy$/i.test(option.name))) return copy("Approval policy", "审批策略");
  if (id === "sandbox") return copy("Sandbox", "沙箱");
  if (id === "mode") return copy("Permission mode", "权限模式");
  if (id === "fast") return copy("Fast mode", "快速模式");
  if (id === "reviewer") return copy("Approval reviewer", "审批审查者");
  if (id === "auto-compaction") return copy("Auto-compaction", "自动压缩");
  if (id === "auto-retry") return copy("Auto-retry", "自动重试");
  if (id === "steering") return copy("Steering mode", "引导模式");
  if (id === "follow-up") return copy("Follow-up mode", "追问模式");
  return option.name;
}

export type ComposerOptionGroups = {
  model?: ChatSessionOption;
  thinking?: ChatSessionOption;
  mode?: ChatSessionOption;
  /** One chip per remaining option, in runtime order. */
  extras: ChatSessionOption[];
};

/** Splits the snapshot the same way the legacy composer did: one model, one thinking, one mode, the rest. */
export function partitionOptions(options: ChatSessionOption[]): ComposerOptionGroups {
  const model = options.find(option => optionCategory(option) === "model");
  const thinking = options.find(option => option !== model && optionCategory(option) === "thinking");
  const mode = options.find(option => option !== model && option !== thinking && optionCategory(option) === "mode");
  const extras = options.filter(option => option !== model && option !== thinking && option !== mode && option.choices.length > 0);
  return { model, thinking, mode, extras };
}

export type FoldResult = { visibleCount: number; foldedCount: number };

/**
 * How many of the foldable chips fit before the "More settings" control.
 * `available` is the width left for the extras area; the cog replaces whatever
 * is folded and counts toward the width. Returns the largest visible prefix.
 */
export function foldExtraChips({
  available,
  gap,
  widths,
  cogWidth,
}: {
  available: number;
  gap: number;
  widths: number[];
  cogWidth: number;
}): FoldResult {
  const count = widths.length;
  if (count === 0) return { visibleCount: 0, foldedCount: 0 };
  const width = (visible: number, cog: boolean) => {
    const children = visible + (cog ? 1 : 0);
    if (children === 0) return 0;
    const sum = widths.slice(0, visible).reduce((total, value) => total + value, 0) + (cog ? cogWidth : 0);
    return sum + gap * (children - 1);
  };
  if (width(count, false) <= available) return { visibleCount: count, foldedCount: 0 };
  for (let visible = count - 1; visible >= 0; visible -= 1) {
    if (width(visible, true) <= available) return { visibleCount: visible, foldedCount: count - visible };
  }
  return { visibleCount: 0, foldedCount: count };
}

export function filterModelChoices(choices: ChatSessionChoice[], query: string): ChatSessionChoice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return choices;
  return choices.filter(choice => choice.name.toLowerCase().includes(needle) || choice.value.toLowerCase().includes(needle));
}

export type ChoiceGroup = { key: string; choices: ChatSessionChoice[] };

/** Groups in first-seen order; choices without a `group` share the empty key. */
export function groupChoices(choices: ChatSessionChoice[]): ChoiceGroup[] {
  const groups: ChoiceGroup[] = [];
  for (const choice of choices) {
    const key = choice.group ?? "";
    const existing = groups.find(group => group.key === key);
    if (existing) existing.choices.push(choice);
    else groups.push({ key, choices: [choice] });
  }
  return groups;
}

export type ModelRow = { kind: "header"; key: string } | { kind: "choice"; choice: ChatSessionChoice };

/** Flattened menu rows (headers + choices) so the list can be virtualized at one row height. */
export function modelRows(choices: ChatSessionChoice[], query: string): ModelRow[] {
  const groups = groupChoices(filterModelChoices(choices, query));
  const withHeaders = groups.some(group => group.key);
  const rows: ModelRow[] = [];
  for (const group of groups) {
    if (withHeaders) rows.push({ kind: "header", key: group.key });
    for (const choice of group.choices) rows.push({ kind: "choice", choice });
  }
  return rows;
}

export function isRecommended(option: ChatSessionOption, choice: ChatSessionChoice): boolean {
  return choice.recommended === true || (option.recommended !== undefined && option.recommended === choice.value);
}

/**
 * One virtual menu slot, in px. Matches the shared `.menu-item` min-height.
 * The model menu sets `--chat-menu-row-height` from this value; every virtual
 * row (header and choice) is pinned to it.
 */
export const MODEL_ROW_HEIGHT = 28;

/** First and last (exclusive) flat rows to render for a scroll position. */
export function virtualWindow({
  count,
  scrollTop,
  rowHeight,
  viewportHeight,
  overscan = 4,
}: {
  count: number;
  scrollTop: number;
  rowHeight: number;
  viewportHeight: number;
  overscan?: number;
}): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const span = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight) + overscan * 2);
  const maxStart = Math.max(0, count - span);
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const start = Math.min(Math.max(0, first - overscan), maxStart);
  const end = Math.min(count, start + span);
  return { start, end };
}
