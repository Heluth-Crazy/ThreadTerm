import { canonicalScopePath } from "./projectScope";
import { formatAgentReference, referencePath } from "./workbench/agentReference";
import type { PagePick, PageTargetRef } from "@threadterm/protocol";
import { deletePageShots } from "./bridge";

export type CommentVersion =
  | { kind: "file" }
  | { kind: "checkpoint"; sessionId: string; checkpointId: string; toCheckpointId?: string }
  | { kind: "git"; staged: boolean }
  | { kind: "commit"; commit: string };
export type CommentScope = { projectId: string; root: string };
export type FileComment = { id: string; projectId: string; root: string; path: string; version: CommentVersion; side: "old" | "new"; startLine: number; endLine: number; excerpt: string; body: string; createdAt: string };
/** Immutable association captured when a page comment is created.  `previewId`, rather than URL, identifies a frame. */
export type PageCommentProvenance = {
  previewId: string;
  sessionId?: string;
  /** Display name captured with the immutable session association; retained after the session closes. */
  sessionTitle?: string;
  providerId?: string;
  requestId?: string;
  documentId?: string;
  tabId?: string;
  workspaceId?: string;
  navigation?: number;
  sequence?: number;
};
export type PageComment = PagePick & CommentScope & { kind: "page"; id: string; body: string; createdAt: string; provenance?: PageCommentProvenance };
export type ReviewComment = FileComment | PageComment;
export type DeletePageShots = (ids: string[]) => void | Promise<void>;

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

function validPage(value: unknown, scope: CommentScope): value is PageComment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>, finite = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number), text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
  const root = typeof item.root === "string" ? item.root : "", url = typeof item.url === "string" ? item.url : "", body = typeof item.body === "string" ? item.body : "";
  const viewport = item.viewport as Record<string, unknown> | undefined;
  if (item.kind !== "page" || !text(item.id, 200) || !item.id || item.projectId !== scope.projectId || !root || canonicalScopePath(root) !== canonicalScopePath(scope.root) || !text(url, 2048) || !/^https?:\/\//i.test(url) || !text(item.title, 200) || !viewport || !finite(viewport.width) || !finite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 || viewport.width > 10000 || viewport.height > 10000 || !item.target || typeof item.target !== "object" || !text(body, MAX_REVIEW_COMMENT_BODY) || !body.trim() || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) return false;
  const provenance = item.provenance as Record<string, unknown> | undefined;
  if (provenance && (!text(provenance.previewId, 200) || !provenance.previewId
    || (provenance.sessionId !== undefined && (!text(provenance.sessionId, 200) || !provenance.sessionId))
    || (provenance.sessionTitle !== undefined && (!text(provenance.sessionTitle, 200) || !provenance.sessionTitle.trim()))
    || (provenance.providerId !== undefined && (!text(provenance.providerId, 100) || !provenance.providerId))
    || (provenance.requestId !== undefined && (!text(provenance.requestId, 200) || !provenance.requestId))
    || (provenance.documentId !== undefined && (!text(provenance.documentId, 200) || !provenance.documentId))
    || (provenance.tabId !== undefined && (!text(provenance.tabId, 200) || !provenance.tabId))
    || (provenance.workspaceId !== undefined && (!text(provenance.workspaceId, 200) || !provenance.workspaceId))
    || (provenance.navigation !== undefined && (!Number.isSafeInteger(provenance.navigation) || (provenance.navigation as number) < 0))
    || (provenance.sequence !== undefined && (!Number.isSafeInteger(provenance.sequence) || (provenance.sequence as number) < 0)))) return false;
  const target = item.target as Record<string, unknown>, rect = target.rect as Record<string, unknown> | undefined, shot = item.shot as Record<string, unknown> | undefined, source = target.source as Record<string, unknown> | undefined;
  if (!rect || !finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height)) return false;
  if (shot && (!text(shot.id, 200) || !shot.id || !text(shot.path, 2048) || !shot.path || !text(shot.thumbnail, 350000) || !/^data:image\/(?:jpeg|png);base64,/i.test(shot.thumbnail) || !finite(shot.width) || !finite(shot.height) || shot.width <= 0 || shot.height <= 0)) return false;
  if (source && (!text(source.file, 400) || !source.file || !["react", "vue", "svelte", "attribute"].includes(String(source.framework)) || (source.line !== undefined && (!Number.isSafeInteger(source.line) || (source.line as number) < 1)) || (source.column !== undefined && (!Number.isSafeInteger(source.column) || (source.column as number) < 1)))) return false;
  if (target.components !== undefined && (!Array.isArray(target.components) || target.components.length > 6 || !target.components.every(item => text(item, 80) && !!item))) return false;
  if (target.type === "element") return text(target.selector, 500) && !!target.selector && text(target.tag, 80) && !!target.tag && text(target.label, 160) && !!target.label && text(target.html, 600) && !!target.attributes && typeof target.attributes === "object" && !Array.isArray(target.attributes) && Object.entries(target.attributes as Record<string, unknown>).every(([key, value]) => text(key, 80) && text(value, 300));
  return target.type === "area" && Array.isArray(target.elements) && target.elements.length <= 8 && target.elements.every(item => text(item, 160) && !!item);
}
function load(scope: CommentScope, store: Store | undefined = storage()): ReviewComment[] {
  try { const value: unknown = JSON.parse(store?.getItem(key(scope)) ?? "[]"); return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && (item as Record<string, unknown>).kind === "page" ? validPage(item, scope) : valid(item, scope)).slice(0, MAX_FILE_COMMENTS) : []; } catch { return []; }
}

export function loadFileComments(scope: CommentScope, store: Store | undefined = storage()): FileComment[] {
  return load(scope, store).filter((comment): comment is FileComment => !isPageComment(comment));
}
export function loadReviewComments(scope: CommentScope, store: Store | undefined = storage()): ReviewComment[] { return load(scope, store); }
function persist(scope: CommentScope, comments: ReviewComment[], store: Store | undefined) {
  if (!store) throw new Error("review_comments_unavailable");
  const storageKey = key(scope);
  if (comments.length) store.setItem(storageKey, JSON.stringify(comments)); else store.removeItem(storageKey);
  try { globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { key: storageKey } })); } catch { /* Node tests have no window events. */ }
}
export function addFileComment(input: Omit<FileComment, "id" | "createdAt" | "excerpt"> & { text: string }, store: Store | undefined = storage()): FileComment[] {
  const body = input.body.trim();
  if (!body) throw new Error("review_comment_empty");
  if (body.length > MAX_REVIEW_COMMENT_BODY) throw new Error("review_comment_too_long");
  const scope = { projectId: input.projectId, root: input.root }, comments = load(scope, store);
  if (comments.length >= MAX_FILE_COMMENTS) throw new Error("review_comments_full");
  const { text, ...rest } = input, comment: FileComment = { ...rest, body, excerpt: reviewExcerpt(text), id: crypto.randomUUID(), createdAt: new Date().toISOString() }, next = [...comments, comment];
  persist(scope, next, store); return next.filter((item): item is FileComment => !isPageComment(item));
}
export function removeFileComments(scope: CommentScope, ids: readonly string[], store: Store | undefined = storage()): FileComment[] {
  const next = load(scope, store).filter(comment => isPageComment(comment) || !ids.includes(comment.id)); persist(scope, next, store); return next.filter((item): item is FileComment => !isPageComment(item));
}
export function isPageComment(comment: ReviewComment): comment is PageComment { return "kind" in comment && comment.kind === "page"; }
export function addPageComment(input: CommentScope & PagePick & { body: string; provenance?: PageCommentProvenance }, store: Store | undefined = storage()): ReviewComment[] {
  const body = input.body.trim();
  if (!body) throw new Error("review_comment_empty");
  if (body.length > MAX_REVIEW_COMMENT_BODY) throw new Error("review_comment_too_long");
  const scope = { projectId: input.projectId, root: input.root }, comments = load(scope, store);
  if (comments.length >= MAX_FILE_COMMENTS) throw new Error("review_comments_full");
  const { body: _body, ...pick } = input, comment: PageComment = { ...pick, kind: "page", body, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, next = [...comments, comment];
  persist(scope, next, store); return next;
}
export function removeReviewComments(scope: CommentScope, ids: readonly string[], store: Store | undefined = storage(), deleteShots: DeletePageShots = deletePageShots): ReviewComment[] {
  const removed = load(scope, store).filter(comment => ids.includes(comment.id)), next = load(scope, store).filter(comment => !ids.includes(comment.id));
  persist(scope, next, store);
  const shots = removed.filter(isPageComment).flatMap(comment => comment.shot ? [comment.shot.id] : []);
  if (shots.length) void deleteShots?.(shots);
  return next;
}
/** Remove comments after their screenshot files have been transferred to a chat composer. */
export function releaseReviewComments(scope: CommentScope, ids: readonly string[], store: Store | undefined = storage()): ReviewComment[] {
  const next = load(scope, store).filter(comment => !ids.includes(comment.id)); persist(scope, next, store); return next;
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

export function pageCommentLabel(target: PageComment["target"], zh: boolean): string {
  if (target.type === "element") return target.label || target.tag;
  return zh ? `区域 ${Math.round(target.rect.width)}×${Math.round(target.rect.height)}` : `Area ${Math.round(target.rect.width)}×${Math.round(target.rect.height)}`;
}
export function pageCommentLocation(url: string): string {
  try { const parsed = new URL(url); return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`; } catch { return url; }
}
export function pageTargetRef(target: PageComment["target"]): PageTargetRef {
  return target.type === "element" ? { selector: target.selector, rect: target.rect } : { rect: target.rect };
}
function formatPageComment(comment: PageComment, zh: boolean, reference: string): string[] {
  const { target } = comment, rect = target.rect, position = `${Math.round(rect.width)}×${Math.round(rect.height)} ${zh ? "位于" : "at"} (${Math.round(rect.x)}, ${Math.round(rect.y)})`, shot = comment.shot ? `${zh ? " · 截图：" : " · Screenshot: "}${comment.shot.path}` : "";
  if (target.type === "area") {
    const contains = target.elements.length ? (zh ? `。包含：${target.elements.map(item => `“${item}”`).join("、")}` : `. Contains: ${target.elements.map(item => `"${item}"`).join(", ")}`) : "";
    return [`- [${reference}] ${pageCommentLabel(target, zh)} ${zh ? "位于" : "at"} (${Math.round(rect.x)}, ${Math.round(rect.y)})${contains}`, `  ${zh ? "截图：" : "Screenshot: "}${comment.shot?.path ?? (zh ? "无" : "none")}`];
  }
  const output = [`- [${reference}] ${pageCommentLabel(target, zh)} (${target.selector})`];
  if (target.source) {
    const source = `${target.source.file}${target.source.line ? `:${target.source.line}${target.source.column ? `:${target.source.column}` : ""}` : ""}`, components = target.components?.length ? ` (${target.source.framework === "react" ? "React" : target.source.framework === "vue" ? "Vue" : target.source.framework === "svelte" ? "Svelte" : target.source.framework}: ${target.components.join(" › ")})` : "";
    output.push(`  ${zh ? "来源：" : "Source: "}${source}${components}`);
  }
  else if (target.components?.length) output.push(`  ${zh ? "组件：" : "Components: "}${target.components.join(" › ")}`);
  const attributes = Object.entries(target.attributes).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ");
  if (attributes) output.push(`  ${zh ? "属性：" : "Attributes: "}${attributes}`);
  output.push(`  HTML: ${target.html}`, `  ${zh ? "边框：" : "Box: "}${position}${shot}`);
  return output;
}
function pageContextIdentity(comment: PageComment, zh: boolean): string[] {
  const provenance = comment.provenance;
  if (!provenance) return [zh ? "  来源预览：手动或旧版页面" : "  Source preview: manual or legacy page"];
  const source = provenance.sessionId
    ? `${provenance.sessionTitle ?? provenance.sessionId}${provenance.providerId ? ` (${provenance.providerId})` : ""}${provenance.sessionTitle ? ` [${provenance.sessionId}]` : ""}`
    : (zh ? "手动页面" : "manual page");
  const lines = [
    `${zh ? "  来源会话：" : "  Source session: "}${source}`,
    `${zh ? "  预览 ID：" : "  Preview ID: "}${provenance.previewId}`,
  ];
  if (provenance.documentId) lines.push(`${zh ? "  文档 ID：" : "  Document ID: "}${provenance.documentId}`);
  if (provenance.tabId) lines.push(`${zh ? "  页面标签 ID：" : "  Page tab ID: "}${provenance.tabId}`);
  if (provenance.navigation !== undefined) lines.push(`${zh ? "  导航版本：" : "  Navigation generation: "}${provenance.navigation}`);
  return lines;
}
/** Formats mixed comments while preserving the historic formatter byte-for-byte for file-only input. */
export function formatReviewComments(comments: readonly ReviewComment[], roots: Roots, zh: boolean): string {
  const files = comments.filter((comment): comment is FileComment => !isPageComment(comment)), pages = comments.filter(isPageComment);
  if (!pages.length) return formatFileComments(files, roots, zh);
  const output = files.length ? [formatFileComments(files, roots, zh)] : [];
  const numbered = pages.map((comment, index) => ({ comment, reference: `P${index + 1}` }));
  const groupKey = (comment: PageComment) => `${comment.provenance?.previewId ?? "legacy"}\0${comment.provenance?.documentId ?? "legacy"}\0${comment.url}`;
  for (const key of new Set(pages.map(groupKey))) {
    const group = numbered.filter(({ comment }) => groupKey(comment) === key), first = group[0].comment;
    output.push([`${zh ? "页面信息" : "Page context"} — ${first.url}${first.title ? (zh ? `（“${first.title}”）` : ` (${JSON.stringify(first.title)})`) : ""}${zh ? "，视口" : ", viewport"} ${Math.round(first.viewport.width)}×${Math.round(first.viewport.height)}:`, ...pageContextIdentity(first, zh), ...group.flatMap(({ comment, reference }) => formatPageComment(comment, zh, reference))].join("\n"));
  }
  output.push([zh ? "页面评论 / 修改要求（对应上面的编号）：" : "Page comments / requested changes (match the references above):", ...numbered.flatMap(({ comment, reference }) => {
    const [body, ...continuation] = comment.body.split(/\r?\n/);
    return [`- [${reference}] ${body}`, ...continuation.map(line => `  ${line}`)];
  })].join("\n"));
  return output.join("\n\n");
}
