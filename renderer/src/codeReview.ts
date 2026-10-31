import type {
  CodeReviewDepth,
  CodeReviewFinding,
  CodeReviewScope,
  CodeReviewSummary,
  CodeReviewVerdict,
  Session,
} from "@threadterm/protocol";

export const CODE_REVIEW_FOCUS_BUDGET = 4 * 1024;
export const CODE_REVIEW_STORAGE_KEY = "threadterm.codeReview.prefs";

export type CodeReviewPrefs = {
  provider?: string;
  model?: string;
  depth?: CodeReviewDepth;
  scopeKind?: CodeReviewScope["kind"];
};

type Copy = (en: string, zh: string) => string;

/** Sessions created for finder/verifier stages must not appear in navigation lists. */
export function isCodeReviewSession(session: Pick<Session, "codeReview"> | undefined | null): boolean {
  return Boolean(session?.codeReview);
}

export function navigableSessions<T extends Pick<Session, "codeReview">>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => !isCodeReviewSession(session));
}

/** Built-in slash command. Not `/review`: Codex and OpenCode have their own, which keep working. */
export const CODE_REVIEW_SLASH = "code-review";

/** `/code-review` and `/code-review focus text` → focus payload; never sends as chat. */
export function parseReviewSlash(text: string): { matched: boolean; focus: string } {
  const trimmed = text.trimStart();
  const match = /^\/code-review(?:\s+|$)(.*)$/is.exec(trimmed);
  if (!match) return { matched: false, focus: "" };
  return { matched: true, focus: match[1]?.trim() ?? "" };
}

export function loadCodeReviewPrefs(): CodeReviewPrefs {
  try {
    const raw = localStorage.getItem(CODE_REVIEW_STORAGE_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as CodeReviewPrefs;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function saveCodeReviewPrefs(prefs: CodeReviewPrefs): void {
  try {
    localStorage.setItem(CODE_REVIEW_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota / private mode */
  }
}

export function defaultCodeReviewProvider(
  providers: readonly { id: string; available: boolean }[],
  chatProvider: string,
  remembered?: string,
): string {
  const available = providers.filter((row) => row.available);
  if (remembered && available.some((row) => row.id === remembered)) return remembered;
  const other = available.find((row) => row.id !== chatProvider);
  if (other) return other.id;
  if (available.some((row) => row.id === chatProvider)) return chatProvider;
  return available[0]?.id ?? chatProvider;
}

/** Finder stage count shown in "Finding issues · k/n". */
export function finderStageTotal(summary: Pick<CodeReviewSummary, "depth" | "stagesTotal">): number {
  if (summary.depth === "quick") return 1;
  return Math.max(1, summary.stagesTotal - 1);
}

export function codeReviewProgressLine(
  summary: CodeReviewSummary,
  copy: Copy,
  options: { awaitingApproval?: boolean } = {},
): string {
  if (options.awaitingApproval) return copy("Waiting for approval", "等待审批");
  switch (summary.stage) {
    case "preparing":
      return copy("Preparing", "准备中");
    case "finding": {
      const total = finderStageTotal(summary);
      const done = Math.min(Math.max(summary.stagesDone, 0), total);
      return copy(`Finding issues · ${done}/${total}`, `查找问题 · ${done}/${total}`);
    }
    case "verifying": {
      const count = summary.candidates ?? summary.findings?.length ?? 0;
      return copy(`Verifying ${count} ${count === 1 ? "finding" : "findings"}`, `正在核实 ${count} 条发现`);
    }
    case "done":
      return copy("Done", "完成");
    default:
      return copy("Running", "运行中");
  }
}

/** Collapsed result line for a finished review, e.g. "2 confirmed · 1 plausible". */
export function codeReviewResultLine(findings: readonly CodeReviewFinding[], copy: Copy): string {
  const count = (verdict: CodeReviewVerdict) => findings.filter((finding) => (finding.verdict ?? "unverified") === verdict).length;
  const confirmed = count("confirmed"), plausible = count("plausible"), unverified = findings.length - confirmed - plausible;
  const parts = [
    confirmed ? copy(`${confirmed} confirmed`, `已确认 ${confirmed}`) : "",
    plausible ? copy(`${plausible} plausible`, `可能成立 ${plausible}`) : "",
    unverified ? copy(`${unverified} unverified`, `未核实 ${unverified}`) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : copy("No issues found", "未发现问题");
}

/** Bilingual label for a scope row; the runtime sends English. */
export function codeReviewScopeLabel(kind: CodeReviewScope["kind"], copy: Copy): string {
  return kind === "session" ? copy("This chat's changes", "此聊天的改动")
    : kind === "branch" ? copy("Branch vs base", "分支对比基线")
    : copy("Uncommitted changes", "未提交的改动");
}

/** Bilingual text for the runtime's known unavailable reasons; anything else is shown as sent. */
export function codeReviewReason(reason: string | undefined, copy: Copy): string | undefined {
  switch (reason) {
    case "Nothing to review": return copy("Nothing to review", "没有可审查的内容");
    case "No known base branch": return copy("No known base branch", "没有已知的基线分支");
    case "Not installed": return copy("Not installed", "未安装");
    case "Not Chat-capable": return copy("Not Chat-capable", "不支持聊天");
    default: return reason;
  }
}

/** Trims text to the focus budget in UTF-8 bytes, which is what the runtime checks. */
export function clampFocus(text: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= CODE_REVIEW_FOCUS_BUDGET) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (used + size > CODE_REVIEW_FOCUS_BUDGET) break;
    out += char;
    used += size;
  }
  return out;
}

const severityRank: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
const verdictOrder: CodeReviewVerdict[] = ["confirmed", "plausible", "unverified"];

export function groupCodeReviewFindings(findings: readonly CodeReviewFinding[]): {
  verdict: CodeReviewVerdict;
  items: CodeReviewFinding[];
}[] {
  const byVerdict = new Map<CodeReviewVerdict, CodeReviewFinding[]>();
  for (const verdict of verdictOrder) byVerdict.set(verdict, []);
  for (const finding of findings) {
    const verdict = verdictOrder.includes(finding.verdict) ? finding.verdict : "unverified";
    byVerdict.get(verdict)!.push(finding);
  }
  for (const items of byVerdict.values()) {
    items.sort((left, right) => (severityRank[left.severity] ?? 9) - (severityRank[right.severity] ?? 9)
      || left.title.localeCompare(right.title));
  }
  return verdictOrder
    .map((verdict) => ({ verdict, items: byVerdict.get(verdict) ?? [] }))
    .filter((group) => group.items.length > 0);
}

export function findingLocation(finding: Pick<CodeReviewFinding, "path" | "line">): string | undefined {
  if (!finding.path) return undefined;
  return finding.line && finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
}

export function composeFixMessage(findings: readonly CodeReviewFinding[]): string {
  const lines = findings.map((finding) => {
    const where = findingLocation(finding);
    const parts = [
      `- **${finding.severity}**${where ? ` \`${where}\`` : ""}: ${finding.title}`,
      finding.body.trim() ? `  ${finding.body.trim()}` : "",
      finding.failureScenario?.trim() ? `  Scenario: ${finding.failureScenario.trim()}` : "",
      `  Verdict: ${finding.verdict}${finding.reason ? ` — ${finding.reason}` : ""}`,
    ];
    return parts.filter(Boolean).join("\n");
  });
  return `${lines.join("\n\n")}\n\nFix the confirmed issues; for plausible ones, check first.`;
}

export function appendComposerText(current: string, addition: string): string {
  const left = current.trimEnd();
  if (!left) return addition;
  return `${left}\n\n${addition}`;
}

export function codeReviewErrorMessage(error: unknown, copy: Copy): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  switch (code || message) {
    case "review_active":
      return copy("A code review is already running in this chat.", "此聊天已有正在进行的代码审查。");
    case "review_empty":
      return copy("Nothing to review in the chosen scope.", "所选范围内没有可审查的改动。");
    case "provider_unavailable":
      return copy("That provider is not available for code review.", "该 Provider 当前不可用于代码审查。");
    case "focus_too_long":
      return copy("Focus text is too long (max 4 KiB).", "关注说明过长（最多 4 KiB）。");
    case "invalid_request":
      return copy("Those review options are not valid.", "审查选项无效。");
    default:
      return message || copy("The review could not start.", "无法开始审查。");
  }
}

export function inboxCodeReviewLabel(session: Session | undefined, copy: Copy): string | undefined {
  if (!session?.codeReview) return undefined;
  return copy("Code review", "代码审查");
}
