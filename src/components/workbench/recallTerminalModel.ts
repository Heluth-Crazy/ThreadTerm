import type { BranchRow } from '../../lib/tauri-bridge';
import {
  effectiveWorktreePath,
  normalizeComparablePath,
  samePath,
  worktreeDisplayLabel,
} from '../../lib/worktreePaths';
import type { TerminalCard } from '../../types/terminal';

export type RecallScope = 'current' | 'all';
export type RecallContextKind = 'path' | 'branch';

export interface RecallProjectOption {
  path: string;
  name: string;
}

export interface RecallContextOption {
  id: string;
  kind: RecallContextKind;
  label: string;
  path: string;
  branchLabel: string | null;
}

export const ALL_RECALL_CONTEXTS = 'all';

export function buildRecallProjectOptions(
  cards: readonly TerminalCard[],
): RecallProjectOption[] {
  const byPath = new Map<string, RecallProjectOption>();
  for (const card of cards) {
    const key = normalizeComparablePath(card.projectPath);
    if (!byPath.has(key)) {
      byPath.set(key, { path: card.projectPath, name: card.projectName });
    }
  }
  return Array.from(byPath.values()).sort(
    (left, right) =>
      left.name
        .toLocaleLowerCase()
        .localeCompare(right.name.toLocaleLowerCase()) ||
      left.path.localeCompare(right.path),
  );
}

export function buildRecallContextOptions(
  cards: readonly TerminalCard[],
  effectiveProjectPath: string | null,
  projectBranches: readonly BranchRow[],
): RecallContextOption[] {
  if (!effectiveProjectPath) return [];
  const byId = new Map<string, RecallContextOption>();
  const byBranchLabel = new Map<string, RecallContextOption>();
  const addContext = (context: RecallContextOption) => {
    byId.set(context.id, context);
    const branchKey = normalizedBranchKey(context.branchLabel);
    if (branchKey) byBranchLabel.set(branchKey, context);
  };

  for (const branch of projectBranches) {
    if (!branch.worktreePath) continue;
    const id = recallPathContextId(branch.worktreePath);
    addContext({
      id,
      kind: 'path',
      label: branch.branch,
      path: branch.worktreePath,
      branchLabel: branch.branch,
    });
  }

  for (const card of cards) {
    if (!samePath(card.projectPath, effectiveProjectPath)) continue;
    const path = effectiveWorktreePath(card);
    const branchLabel = normalizedBranchLabel(card.branchLabel);
    const recognizedBranchContext = branchLabel
      ? byBranchLabel.get(normalizedBranchKey(branchLabel) ?? '')
      : undefined;
    if (recognizedBranchContext) continue;

    const pathId = recallPathContextId(path);
    const existingPath = byId.get(pathId);

    if (existingPath) {
      if (
        !branchLabel ||
        !existingPath.branchLabel ||
        sameBranchLabel(existingPath.branchLabel, branchLabel)
      ) {
        continue;
      }
      const branchId = recallBranchContextId(path, branchLabel);
      if (!byId.has(branchId)) {
        addContext({
          id: branchId,
          kind: 'branch',
          label: branchLabel,
          path,
          branchLabel,
        });
      }
      continue;
    }

    const hasDistinctWorktreePath =
      Boolean(card.worktreePath) &&
      !samePath(card.worktreePath, card.projectPath);
    if (hasDistinctWorktreePath || !branchLabel) {
      addContext({
        id: pathId,
        kind: 'path',
        label: worktreeDisplayLabel(card),
        path,
        branchLabel,
      });
      continue;
    }

    const branchId = recallBranchContextId(path, branchLabel);
    if (!byId.has(branchId)) {
      addContext({
        id: branchId,
        kind: 'branch',
        label: branchLabel,
        path,
        branchLabel,
      });
    }
  }
  return Array.from(byId.values()).sort(
    (left, right) =>
      left.label
        .toLocaleLowerCase()
        .localeCompare(right.label.toLocaleLowerCase()) ||
      left.path.localeCompare(right.path),
  );
}

export function filterRecallCards(
  cards: readonly TerminalCard[],
  effectiveProjectPath: string | null,
  selectedContext: RecallContextOption | null,
  normalizedQuery: string,
): TerminalCard[] {
  return cards.filter((card) => {
    if (
      effectiveProjectPath &&
      !samePath(card.projectPath, effectiveProjectPath)
    ) {
      return false;
    }
    if (selectedContext && !cardMatchesRecallContext(card, selectedContext)) {
      return false;
    }
    return !normalizedQuery || recallSearchText(card).includes(normalizedQuery);
  });
}

export function recallPathContextId(path: string): string {
  return `path:${normalizeComparablePath(path)}`;
}

function recallSearchText(card: TerminalCard): string {
  return [
    card.projectName,
    card.projectPath,
    card.worktreePath,
    card.branchLabel,
    card.terminalType,
    card.lastReplyPreview,
    card.lastOutput,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function recallBranchContextId(path: string, branchLabel: string): string {
  return `branch:${normalizeComparablePath(path)}\u001f${branchLabel.toLocaleLowerCase()}`;
}

function normalizedBranchLabel(
  branchLabel: string | null | undefined,
): string | null {
  const normalized = branchLabel?.trim();
  return normalized ? normalized : null;
}

function normalizedBranchKey(
  branchLabel: string | null | undefined,
): string | null {
  return normalizedBranchLabel(branchLabel)?.toLocaleLowerCase() ?? null;
}

function sameBranchLabel(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizedBranchKey(left);
  const normalizedRight = normalizedBranchKey(right);
  return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
}

function cardMatchesRecallContext(
  card: TerminalCard,
  context: RecallContextOption,
): boolean {
  if (context.kind === 'branch') {
    return sameBranchLabel(card.branchLabel, context.branchLabel);
  }
  if (
    context.branchLabel &&
    card.branchLabel &&
    sameBranchLabel(card.branchLabel, context.branchLabel)
  ) {
    return true;
  }
  if (!samePath(effectiveWorktreePath(card), context.path)) return false;
  if (!context.branchLabel || !card.branchLabel) return true;
  return sameBranchLabel(card.branchLabel, context.branchLabel);
}
