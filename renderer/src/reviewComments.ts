import { canonicalScopePath } from "./projectScope";
import { formatAgentReference, referencePath } from "./workbench/agentReference";

export type CommentVersion =
  | { kind: "file" }
  | { kind: "checkpoint"; sessionId: string; checkpointId: string; toCheckpointId?: string }
  | { kind: "git"; staged: boolean }
  | { kind: "commit"; commit: string };
export type CommentScope = { projectId: string; root: string };
export type FileComment = { id: string; projectId: string; root: string; path: string; version: CommentVersion; side: "old" | "new"; startLine: number; endLine: number; excerpt: string; body: string; createdAt: string };

export const MAX_FILE_COMMENTS = 200;
export const MAX_REVIEW_COMMENT_BODY = 4000;
const MAX_EXCERPT = 160;
const EVENT = "threadterm:file-comments";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Roots = { fileRoot: string; sessionRoot?: string };
const storage = (): Store | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
const key = (scope: CommentScope) => `threadterm.v3.file-comments:${scope.projectId}:${canonicalScopePath(scope.root) ?? ""}`;
const range = (comment: Pick<FileComment, "startLine" | "endLine">) => comment.endLine > comment.startLine ? `${comment.startLine}-${comment.endLine}` : `${comment.startLine}`;
const many = (comment: Pick<FileComment, "startLine" | "endLine">) => comment.endLine > comment.startLine;

/** The first non-empty selected line, trimmed and bounded; "…" when more was selected. */
export function reviewExcerpt(text: string): string {
  const lines = text.split(/\r?\n/);
  const first = lines.find(line => line.trim())?.trim() ?? "";
  const more = lines.filter(line => line.trim()).length > 1 || first.length > MAX_EXCERPT;
  return first.slice(0, MAX_EXCERPT) + (more ? " …" : "");
}

function validVersion(value: unknown): value is CommentVersion {
  if (!value || typeof value !== "object") return false;
  const version = value as Record<string, unknown>;
  if (version.kind === "file") return Object.keys(version).length === 1;
  if (version.kind === "checkpoint") return typeof version.sessionId === "string" && !!version.sessionId && typeof version.checkpointId === "string" && !!version.checkpointId && (version.toCheckpointId === undefined || (typeof version.toCheckpointId === "string" && !!version.toCheckpointId));
  if (version.kind === "git") return typeof version.staged === "boolean";
  return version.kind === "commit" && typeof version.commit === "string" && !!version.commit;
}
function valid(value: unknown, scope: CommentScope): value is FileComment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>, line = (number: unknown) => Number.isSafeInteger(number) && (number as number) >= 1;
  return typeof item.id === "string" && !!item.id && item.projectId === scope.projectId && typeof item.root === "string" && !!canonicalScopePath(item.root) && canonicalScopePath(item.root) === canonicalScopePath(scope.root)
    && typeof item.path === "string" && !!item.path && !/[\\\u0000]/.test(item.path) && !/^(?:\/|[a-z]:)/i.test(item.path) && item.path.split("/").every(part => !!part && part !== "." && part !== "..") && validVersion(item.version)
    && (item.side === "old" || item.side === "new") && line(item.startLine) && line(item.endLine) && (item.endLine as number) >= (item.startLine as number)
    && typeof item.excerpt === "string" && typeof item.body === "string" && !!item.body.trim() && item.body.length <= MAX_REVIEW_COMMENT_BODY && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt));
}

export function loadFileComments(scope: CommentScope, store: Store | undefined = storage()): FileComment[] {
  try { const value: unknown = JSON.parse(store?.getItem(key(scope)) ?? "[]"); return Array.isArray(value) ? value.filter(item => valid(item, scope)).slice(0, MAX_FILE_COMMENTS) : []; } catch { return []; }
}
function persist(scope: CommentScope, comments: FileComment[], store: Store | undefined) {
  if (!store) throw new Error("review_comments_unavailable");
  const storageKey = key(scope);
  if (comments.length) store.setItem(storageKey, JSON.stringify(comments)); else store.removeItem(storageKey);
  try { globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { key: storageKey } })); } catch { /* Node tests have no window events. */ }
}
export function addFileComment(input: Omit<FileComment, "id" | "createdAt" | "excerpt"> & { text: string }, store: Store | undefined = storage()): FileComment[] {
  const body = input.body.trim();
  if (!body) throw new Error("review_comment_empty");
  if (body.length > MAX_REVIEW_COMMENT_BODY) throw new Error("review_comment_too_long");
  const scope = { projectId: input.projectId, root: input.root }, comments = loadFileComments(scope, store);
  if (comments.length >= MAX_FILE_COMMENTS) throw new Error("review_comments_full");
  const { text, ...rest } = input, comment: FileComment = { ...rest, body, excerpt: reviewExcerpt(text), id: crypto.randomUUID(), createdAt: new Date().toISOString() }, next = [...comments, comment];
  persist(scope, next, store); return next;
}
export function removeFileComments(scope: CommentScope, ids: readonly string[], store: Store | undefined = storage()): FileComment[] {
  const next = loadFileComments(scope, store).filter(comment => !ids.includes(comment.id)); persist(scope, next, store); return next;
}
export function subscribeFileComments(scope: CommentScope, listener: () => void): () => void {
  const storageKey = key(scope), local = (event: Event) => { if ((event as CustomEvent<{ key?: string }>).detail?.key === storageKey) listener(); }, shared = (event: StorageEvent) => { if (event.key === storageKey) listener(); };
  addEventListener(EVENT, local); addEventListener("storage", shared);
  return () => { removeEventListener(EVENT, local); removeEventListener("storage", shared); };
}

export function sameCommentVersion(a: CommentVersion, b: CommentVersion): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return true;
  if (a.kind === "checkpoint" && b.kind === "checkpoint") return a.sessionId === b.sessionId && a.checkpointId === b.checkpointId && a.toCheckpointId === b.toCheckpointId;
  if (a.kind === "git" && b.kind === "git") return a.staged === b.staged;
  return a.kind === "commit" && b.kind === "commit" && a.commit === b.commit;
}

export function fileCommentPlace(comment: Pick<FileComment, "path" | "version" | "side" | "startLine" | "endLine">, roots: Roots, zh: boolean): string {
  const lineRange = range(comment), shown = referencePath(comment.path, roots.fileRoot, roots.sessionRoot);
  // Lines of the current file read `path:R` (the Send to agent reference); other versions name the file without lines,
  // since `path:R` would point into the current file.
  const plain = formatAgentReference({ path: shown, startLine: comment.startLine, endLine: comment.endLine }), bare = formatAgentReference({ path: shown });
  const suffix = (english: string, chinese: string) => zh ? `（${chinese}，第 ${lineRange} 行）` : ` (${english}, line${many(comment) ? "s" : ""} ${lineRange})`;
  const { version } = comment;
  if (version.kind === "file" || (version.kind === "checkpoint" && comment.side === "new" && !version.toCheckpointId) || (version.kind === "git" && !version.staged && comment.side === "new")) return plain;
  if (version.kind === "checkpoint") return bare + (comment.side === "old" ? suffix("at the checkpoint", "检查点版本") : suffix("at a later checkpoint", "较新的检查点"));
  if (version.kind === "git") return bare + (version.staged ? suffix(comment.side === "old" ? "at HEAD" : "staged version", comment.side === "old" ? "HEAD 版本" : "暂存版本") : suffix("before the uncommitted changes", "未提交改动之前"));
  const commit = version.commit.slice(0, 7);
  return bare + suffix(comment.side === "old" ? `before commit ${commit}` : `in commit ${commit}`, comment.side === "old" ? `提交 ${commit} 之前` : `提交 ${commit} 中`);
}
export function fileCommentShortPlace(comment: Pick<FileComment, "path" | "version" | "side" | "startLine" | "endLine">, zh: boolean): string {
  const name = comment.path.slice(comment.path.lastIndexOf("/") + 1), { version } = comment;
  let suffix = "";
  if (version.kind === "checkpoint") suffix = comment.side === "old" ? (zh ? "（检查点）" : " (checkpoint)") : version.toCheckpointId ? (zh ? "（较新检查点）" : " (later checkpoint)") : "";
  else if (version.kind === "git") suffix = version.staged ? (comment.side === "old" ? (zh ? "（HEAD）" : " (HEAD)") : (zh ? "（暂存）" : " (staged)")) : comment.side === "old" ? (zh ? "（未提交改动前）" : " (before uncommitted)") : "";
  else if (version.kind === "commit") { const commit = version.commit.slice(0, 7); suffix = comment.side === "old" ? (zh ? `（提交 ${commit} 之前）` : ` (before ${commit})`) : (zh ? `（提交 ${commit}）` : ` (commit ${commit})`); }
  return `${name}:${range(comment)}${suffix}`;
}
export function formatFileComments(comments: readonly FileComment[], roots: Roots, zh: boolean): string {
  const output = [zh ? "审查意见：" : "Review comments:"];
  for (const path of new Set(comments.map(comment => comment.path))) for (const comment of comments.filter(item => item.path === path)) {
    const [first, ...rest] = comment.body.split(/\r?\n/);
    output.push(`- ${fileCommentPlace(comment, roots, zh)} — ${first}`, ...rest.map(line => `  ${line}`));
    if (comment.excerpt) output.push(`  > ${comment.excerpt}`);
  }
  return output.join("\n");
}
