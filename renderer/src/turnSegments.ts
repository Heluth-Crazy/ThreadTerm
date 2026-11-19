import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { shouldRenderPart } from './chatPresentation';
import { hiddenTool, toolEntry, type ToolActivityEntry } from './toolActivity';

/**
 * One turn's blocks: a work fold per maximal run of process parts, and the content
 * parts (answer, pending interaction, error, status, cards) between them. Process parts
 * come from assistant rows and from the separate tool rows most adapters record.
 *
 * Live and settled turns run the same pass, so a fold never moves or remounts when the
 * turn ends: only its header changes (see ToolActivity). The one exception is an adapter
 * that records a resolved interaction after the answer (see `seatLateInteractions`).
 * A turn whose prose is one growing item that precedes its tools (Claude, pi, Grok) shows
 * that prose after the fold, live and settled alike (see `answerIds`, `seatAfterProcess`).
 */

export interface FoldThinkingStep {
  kind: 'thinking';
  /** Stable per part: `${itemId}:${partIndex}`. */
  id: string;
  itemId: string;
  part: ChatPart;
}

export interface FoldCommentaryStep {
  kind: 'commentary';
  id: string;
  itemId: string;
  part: ChatPart;
}

export interface FoldApprovalStep {
  kind: 'approval';
  id: string;
  itemId: string;
  part: ChatPart;
}

export type FoldPartStep = FoldThinkingStep | FoldCommentaryStep | FoldApprovalStep;

export interface FoldToolStep {
  kind: 'tool';
  id: string;
  entry: ToolActivityEntry;
}

export type FoldStep = FoldPartStep | FoldToolStep;

export type TurnBlock =
  | { kind: 'fold'; id: string; steps: FoldStep[] }
  /** `seated`: prose shown after the fold it precedes in the record (see `answerIds`). */
  | { kind: 'item'; id: string; item: ChatItem; seated?: true };

export interface TurnSegmentsOptions {
  /**
   * Codex marks commentary with `phase`; when an older record has no phase at all, only
   * the last assistant text item is the answer (the pre-existing fallback). Other
   * providers keep every trailing text record as the answer (ACP splits it).
   */
  collapseCommentary?: boolean;
  /** Items rendered whole as one card (usage cards, the user bubble, system rows). */
  wholeItems?: ReadonlySet<string>;
  /**
   * The turn has ended. Only then is a resolved interaction recorded after the answer seated before it
   * (see `seatLateInteractions`); a live turn keeps the native order so nothing moves under the reader.
   */
  settled?: boolean;
}

type PartRef = { item: ChatItem; part: ChatPart; index: number };

const isText = (part: ChatPart): part is ChatPart & { text: string } => part.type === 'text' && typeof part.text === 'string' && !!part.text.trim();

/** A plan-quota card is a text part with `data.kind === 'plan'`; it renders as its own card. */
const isCardText = (part: ChatPart): boolean => isText(part)
  && !!part.data && typeof part.data === 'object' && (part.data as Record<string, unknown>).kind === 'plan';

/** Parts that exist for the model at all. Empty rows are hidden (owner rule). */
function visiblePart(part: ChatPart): boolean {
  if (part.type === 'plan' || part.type === 'usage') return false;
  if (part.type === 'tool') return !hiddenTool(part);
  return shouldRenderPart(part);
}

const PENDING_APPROVAL = 'pending';

const refKey = (ref: PartRef): string => `${ref.item.id}:${ref.index}`;

/**
 * Rows the agent produced. Codex, ACP agents and Grok record each tool call as its own `role: 'tool'` row, so
 * those fold with the assistant's rows; only the user's message and system rows stay whole, as before the fold.
 */
const agentRow = (item: ChatItem): boolean => item.role !== 'user' && item.role !== 'system';

function isProcessPart(part: ChatPart): boolean {
  return part.type === 'thinking' || part.type === 'tool';
}

/**
 * The answer: `final_answer`, or text with no thinking/tool call after it in the turn.
 * A resolved approval and a commentary text do not end that look-ahead; any content
 * part (answer text, pending interaction, error, status, card) does.
 *
 * `seated` holds the answers that come before the turn's last process part and are shown after it
 * instead (see the fallback at the end).
 */
function answerIds(items: readonly ChatItem[], collapseCommentary: boolean): { answers: Set<string>; seated: Set<string> } {
  const refs: PartRef[] = [];
  for (const item of items) {
    if (!agentRow(item)) continue;
    item.parts.forEach((part, index) => { if (visiblePart(part) || isCardText(part)) refs.push({ item, part, index }); });
  }
  const hasPhase = refs.some(ref => isText(ref.part) && !!ref.part.phase);
  let lastTextItemId: string | undefined;
  if (collapseCommentary && !hasPhase) {
    for (const ref of refs) if (ref.item.role === 'assistant' && isText(ref.part)) lastTextItemId = ref.item.id;
  }
  const answers = new Set<string>();
  let processAhead = false;
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const { item, part } = refs[index]!;
    if (isProcessPart(part)) { processAhead = true; continue; }
    if (part.type === 'approval') {
      if (part.status !== PENDING_APPROVAL) continue;
      processAhead = false;
      continue;
    }
    if (!isText(part) || isCardText(part)) {
      // Error, status and card parts are content: they end the run.
      processAhead = false;
      continue;
    }
    if (part.phase === 'commentary') continue;
    if (part.phase === 'final_answer') { answers.add(`${item.id}:${refs[index]!.index}`); processAhead = false; continue; }
    // Unphased text.
    if (collapseCommentary && !hasPhase) {
      if (item.id === lastTextItemId) { answers.add(`${item.id}:${refs[index]!.index}`); processAhead = false; }
      continue;
    }
    if (collapseCommentary) {
      // A phased Codex turn: text the provider left unmarked is the answer, as before.
      answers.add(`${item.id}:${refs[index]!.index}`);
      processAhead = false;
      continue;
    }
    if (!processAhead) { answers.add(`${item.id}:${refs[index]!.index}`); processAhead = false; }
  }
  const seated = new Set<string>();
  if (!collapseCommentary) {
    // Claude, pi, Grok and imported ACP turns keep the turn's prose in ONE item that is created before the
    // tool calls and keeps growing, so the answer written after the tools sits in front of them. With no
    // text after the turn's last process part, its last run of text is the answer: shown after the work it
    // reports instead of folded away (11-19: the fold hid Claude's whole answer). The same rule holds while
    // the turn is live, so nothing moves when it ends; a later text record takes the answer over as usual.
    const isProse = (ref: PartRef | undefined): boolean => !!ref && isText(ref.part) && !isCardText(ref.part) && ref.part.phase !== 'commentary';
    const lastProcess = refs.findLastIndex(ref => isProcessPart(ref.part));
    const lastProse = refs.findLastIndex(isProse);
    // Only prose the look-ahead would fold: text a content part already set apart stays an answer in place.
    if (lastProse >= 0 && lastProse < lastProcess && !answers.has(refKey(refs[lastProse]!))) {
      for (let index = lastProse; index >= 0 && isProse(refs[index]) && !answers.has(refKey(refs[index]!)); index -= 1) {
        answers.add(refKey(refs[index]!));
        seated.add(refKey(refs[index]!));
      }
    }
  }
  return { answers, seated };
}

type Entry = { kind: 'whole'; item: ChatItem } | ({ kind: 'part' } & PartRef);


/**
 * Adapters may record a resolved question or approval after the final answer: a late update of an older
 * row, or the answer appended to the row that carries the question. A settled turn seats those before the
 * answer, as the settled view always did, so the answer stays last and no fold opens under it. Pending
 * ones stay where they are (they are content). Entries keep their part index, so ids do not change.
 */
function seatLateInteractions(entries: Entry[], answers: ReadonlySet<string>): Entry[] {
  const isAnswer = (entry: Entry | undefined): boolean => entry?.kind === 'part' && isText(entry.part) && answers.has(refKey(entry));
  const final = entries.findLastIndex(isAnswer);
  if (final < 0) return entries;
  const resolved = (entry: Entry): boolean => entry.kind === 'part' && entry.part.type === 'approval' && entry.part.status !== PENDING_APPROVAL;
  const late = entries.slice(final + 1);
  if (!late.some(resolved)) return entries;
  let start = final;
  while (start > 0 && isAnswer(entries[start - 1])) start -= 1;
  return [...entries.slice(0, start), ...late.filter(resolved), ...entries.slice(start, final + 1), ...late.filter(entry => !resolved(entry))];
}

/** Moves the seated answers (see `answerIds`) after the turn's last folded part, keeping their order. */
function seatAfterProcess(entries: Entry[], seated: ReadonlySet<string>): Entry[] {
  const folded = (entry: Entry): boolean => entry.kind === 'part'
    && (isProcessPart(entry.part) || (entry.part.type === 'approval' && entry.part.status !== PENDING_APPROVAL));
  const last = entries.findLastIndex(folded);
  const moving = entries.filter((entry, index) => index < last && entry.kind === 'part' && seated.has(refKey(entry)));
  if (!moving.length) return entries;
  const rest = entries.filter(entry => !moving.includes(entry));
  const at = rest.findLastIndex(folded) + 1;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/**
 * Segment one turn. Content parts of the same item merge into one block, so a card and
 * the text around it keep rendering as the item they came from.
 */
export function turnSegments(items: readonly ChatItem[], options: TurnSegmentsOptions = {}): TurnBlock[] {
  const { answers, seated } = answerIds(items, options.collapseCommentary === true);
  const whole = options.wholeItems ?? new Set<string>();
  let entries: Entry[] = [];
  for (const item of items) {
    if (!agentRow(item) || whole.has(item.id)) {
      entries.push({ kind: 'whole', item });
      continue;
    }
    item.parts.forEach((part, index) => {
      if (visiblePart(part) || isCardText(part)) entries.push({ kind: 'part', item, part, index });
    });
  }
  if (seated.size) entries = seatAfterProcess(entries, seated);
  if (options.settled) entries = seatLateInteractions(entries, answers);
  const blocks: TurnBlock[] = [];
  const toolIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'whole') {
      blocks.push({ kind: 'item', id: `item:${entry.item.id}`, item: entry.item });
      continue;
    }
    const { item, part, index } = entry;
    const stepId = `${item.id}:${index}`;
    const parent = blocks.at(-1);
    const process = isProcessPart(part)
      || (part.type === 'approval' && part.status !== PENDING_APPROVAL)
      || (isText(part) && !isCardText(part) && !answers.has(stepId));
    if (!process) {
      if (parent?.kind === 'item' && parent.item.id === item.id) parent.item = { ...parent.item, parts: [...parent.item.parts, part] };
      else blocks.push({ kind: 'item', id: `item:${stepId}`, item: { ...item, parts: [part] }, ...(seated.has(stepId) ? { seated: true as const } : {}) });
      continue;
    }
    let step: FoldStep;
    if (part.type === 'tool') {
      const toolEntryValue = toolEntry(item, part, index);
      if (toolIds.has(toolEntryValue.id)) toolEntryValue.id = `${toolEntryValue.id}:${index}`;
      toolIds.add(toolEntryValue.id);
      step = { kind: 'tool', id: stepId, entry: toolEntryValue };
    } else if (part.type === 'thinking') {
      step = { kind: 'thinking', id: stepId, itemId: item.id, part };
    } else if (part.type === 'text') {
      step = { kind: 'commentary', id: stepId, itemId: item.id, part };
    } else {
      step = { kind: 'approval', id: stepId, itemId: item.id, part };
    }
    if (parent?.kind === 'fold') parent.steps.push(step);
    else blocks.push({ kind: 'fold', id: `fold:${stepId}`, steps: [step] });
  }
  return blocks;
}

/** Every tool step of a fold, in order; `ToolActivity` / `ToolCard` consume these. */
export function foldToolEntries(steps: readonly FoldStep[]): ToolActivityEntry[] {
  return steps.flatMap(step => step.kind === 'tool' ? [step.entry] : []);
}

/** The newest thinking step still streaming inside this fold. */
export function foldIsThinking(steps: readonly FoldStep[]): boolean {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.kind === 'tool') return false;
    if (step.kind === 'thinking') return step.part.status === 'streaming';
    if (step.kind === 'commentary') return false;
  }
  return false;
}

/** The last commentary line of this fold, for the collapsed second line. */
export function foldCommentary(steps: readonly FoldStep[]): string | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.kind === 'commentary') return step.part.text;
  }
  return undefined;
}

/** True when the fold has nothing but a thinking step (its header says 思考过程 when settled). */
export function foldIsThinkingOnly(steps: readonly FoldStep[]): boolean {
  return steps.length > 0 && steps.every(step => step.kind === 'thinking');
}

/** The newest step, used as the live headline when nothing is running. */
export function foldLatestStep(steps: readonly FoldStep[]): FoldStep | undefined {
  return steps.at(-1);
}

/** Consecutive folds are separated by content, so this is the newest output segment. */
export function lastFoldIndex(blocks: readonly TurnBlock[]): number {
  return blocks.findLastIndex(block => block.kind === 'fold');
}
