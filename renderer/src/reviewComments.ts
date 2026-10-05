import { formatAgentReference } from "./workbench/agentReference";

/** Which document of a review diff a comment points into: the checkpoint ("old") or the newer text ("new"). */
export type ReviewSide = "old" | "new";

/** A comment on lines of an agent's changes, kept per source session until it goes into that agent's message box. */
export type ReviewComment = {
  id: string;
  sessionId: string;
  /** The comparison the lines belong to (marks show only there). */
  checkpointId: string;
  toCheckpointId?: string;
  /** Relative to the session's own folder, which is also where the receiving agent works. */
  path: string;
  side: ReviewSide;
  /** Whether "new" lines are the current file (checkpoint → current file) or a later checkpoint. */
  current: boolean;
  startLine: number;
  endLine: number;
  excerpt: string;
  body: string;
  createdAt: string;
};

export const MAX_REVIEW_COMMENTS = 100;
export const MAX_REVIEW_COMMENT_BODY = 4000;
const MAX_EXCERPT = 160;
const EVENT = "threadterm:review-comments";
const key = (sessionId: string) => `threadterm.v3.review-comments.${sessionId}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): Store | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

/** The first non-empty selected line, trimmed and bounded; "…" when more was selected. */
export function reviewExcerpt(text: string): string {
  const lines = text.split(/\r?\n/);
  const first = lines.find(line => line.trim())?.trim() ?? "";
  const more = lines.filter(line => line.trim()).length > 1 || first.length > MAX_EXCERPT;
  return first.slice(0, MAX_EXCERPT) + (more ? " …" : "");
}

function valid(value: unknown, sessionId: string): value is ReviewComment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const line = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 1;
  return typeof item.id === "string" && item.sessionId === sessionId && typeof item.path === "string" && !!item.path
    && typeof item.checkpointId === "string" && !!item.checkpointId && (item.toCheckpointId === undefined || typeof item.toCheckpointId === "string")
    && (item.side === "old" || item.side === "new") && typeof item.current === "boolean" && line(item.startLine) && line(item.endLine)
    && (item.endLine as number) >= (item.startLine as number) && typeof item.excerpt === "string" && typeof item.body === "string"
    && !!item.body.trim() && item.body.length <= MAX_REVIEW_COMMENT_BODY && typeof item.createdAt === "string";
}

/** The session's pending comments; unreadable or foreign entries are dropped, never shown half-valid. */
export function loadReviewComments(sessionId: string, store: Store | undefined = storage()): ReviewComment[] {
  try {
    const value: unknown = JSON.parse(store?.getItem(key(sessionId)) ?? "[]");
    return Array.isArray(value) ? value.filter(item => valid(item, sessionId)).slice(0, MAX_REVIEW_COMMENTS) : [];
  } catch { return []; }
}

function persist(sessionId: string, comments: ReviewComment[], store: Store | undefined) {
  if (!store) throw new Error("review_comments_unavailable");
  if (comments.length) store.setItem(key(sessionId), JSON.stringify(comments));
  else store.removeItem(key(sessionId));
  try { globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { sessionId } })); } catch { /* Node tests have no window events. */ }
}

export function addReviewComment(input: Omit<ReviewComment, "id" | "createdAt" | "excerpt"> & { text: string }, store: Store | undefined = storage()): ReviewComment[] {
  const body = input.body.trim();
  if (!body) throw new Error("review_comment_empty");
  if (body.length > MAX_REVIEW_COMMENT_BODY) throw new Error("review_comment_too_long");
  const comments = loadReviewComments(input.sessionId, store);
  if (comments.length >= MAX_REVIEW_COMMENTS) throw new Error("review_comments_full");
  const { text, ...rest } = input;
  const comment: ReviewComment = { ...rest, body, excerpt: reviewExcerpt(text), id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const next = [...comments, comment];
  persist(input.sessionId, next, store);
  return next;
}

export function removeReviewComments(sessionId: string, ids: readonly string[], store: Store | undefined = storage()): ReviewComment[] {
  const next = loadReviewComments(sessionId, store).filter(comment => !ids.includes(comment.id));
  persist(sessionId, next, store);
  return next;
}

/** Calls `listener` when this window or another one changes the session's comments. */
export function subscribeReviewComments(sessionId: string, listener: () => void): () => void {
  const local = (event: Event) => { if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId === sessionId) listener(); };
  const shared = (event: StorageEvent) => { if (event.key === key(sessionId)) listener(); };
  addEventListener(EVENT, local);
  addEventListener("storage", shared);
  return () => { removeEventListener(EVENT, local); removeEventListener("storage", shared); };
}

/** Where a comment points, as the agent should read it: `src/a.ts:12-14` for lines of the current file (the same
 * reference "Send to agent" inserts); other lines say which version they come from, since the agent reads the
 * current file. */
export function reviewCommentPlace(comment: Pick<ReviewComment, "path" | "side" | "current" | "startLine" | "endLine">, zh: boolean): string {
  if (comment.side === "new" && comment.current) return formatAgentReference({ path: comment.path, startLine: comment.startLine, endLine: comment.endLine });
  const many = comment.endLine > comment.startLine, range = many ? `${comment.startLine}-${comment.endLine}` : `${comment.startLine}`;
  const version = comment.side === "old"
    ? (zh ? `（改动前，第 ${range} 行）` : ` (before your change, line${many ? "s" : ""} ${range})`)
    : (zh ? `（较新的检查点，第 ${range} 行）` : ` (at a later checkpoint, line${many ? "s" : ""} ${range})`);
  return formatAgentReference({ path: comment.path }) + version;
}

/** Compact label for the pending-comments list: `cart.ts:2`, `cart.ts:2-4 (before)`, `cart.ts:3 (later)`. */
export function reviewCommentShortPlace(comment: Pick<ReviewComment, "path" | "side" | "current" | "startLine" | "endLine">, zh: boolean): string {
  const name = comment.path.slice(comment.path.lastIndexOf("/") + 1);
  const range = comment.endLine > comment.startLine ? `${comment.startLine}-${comment.endLine}` : `${comment.startLine}`;
  const version = comment.side === "old" ? (zh ? "（改动前）" : " (before)") : comment.current ? "" : (zh ? "（较新检查点）" : " (later)");
  return `${name}:${range}${version}`;
}

/** One block for the agent's message box: grouped by file in the order the files were first commented on, each
 * file's comments in the order they were written. */
export function formatReviewComments(comments: readonly ReviewComment[], zh: boolean): string {
  const lines = [zh ? "对你的改动的审查意见：" : "Review comments on your changes:"];
  for (const path of new Set(comments.map(comment => comment.path))) {
    for (const comment of comments.filter(item => item.path === path)) {
      const [first, ...rest] = comment.body.split(/\r?\n/);
      lines.push(`- ${reviewCommentPlace(comment, zh)} — ${first}`, ...rest.map(line => `  ${line}`));
      if (comment.excerpt) lines.push(`  > ${comment.excerpt}`);
    }
  }
  return lines.join("\n");
}
