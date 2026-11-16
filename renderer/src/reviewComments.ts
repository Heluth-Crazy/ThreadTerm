import { isLocalHtmlPreviewUrl } from './htmlPreviewUrl';
import { canonicalScopePath } from "./projectScope";
import { formatAgentReference, referencePath } from "./workbench/agentReference";
import type { PagePick, PageTargetRef } from "@threadterm/protocol";
import { operationId, request, subscribeEvents } from "./bridge";
import { isAbsoluteFilePath } from './externalFiles';
import { persistRemotePageShot } from './remoteFiles';

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
/** A comment without a line range, for views that have no line numbers: large-file windows, rendered previews, documents
 * and images. `excerpt` quotes the selected text and is empty for a whole-file comment; `offset` is the selection's byte
 * position in a large file. */
export type NoteComment = CommentScope & { kind: "note"; id: string; path: string; excerpt: string; offset?: number; body: string; createdAt: string };
export type ReviewComment = FileComment | PageComment | NoteComment;

export const MAX_FILE_COMMENTS = 200;
export const MAX_REVIEW_COMMENT_BODY = 4000;
const MAX_EXCERPT = 160;
type Roots = { fileRoot: string; sessionRoot?: string };
const LEGACY_PREFIX = "threadterm.v3.file-comments:";
const LEGACY_MARKER = "review-comments-local-storage-v1";
const LEGACY_IMPORT_BATCH = 8;
const revisions = new Map<string, number>();
let legacyImport: Promise<void> | undefined;
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
/** A workspace-relative path with forward slashes, or an absolute path of a file outside the workspace. */
function validCommentPath(path: unknown): path is string {
  return typeof path === "string" && !!path && (isAbsoluteFilePath(path)
    ? !/[\u0000-\u001f\u007f-\u009f]/.test(path) && new TextEncoder().encode(path).length <= 16_384
    : !/[\\\u0000]/.test(path) && !/^[a-z]:/i.test(path) && path.split("/").every(part => !!part && part !== "." && part !== ".."));
}
function valid(value: unknown, scope: CommentScope): value is FileComment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>, line = (number: unknown) => Number.isSafeInteger(number) && (number as number) >= 1;
  return typeof item.id === "string" && !!item.id && item.projectId === scope.projectId && typeof item.root === "string" && !!canonicalScopePath(item.root) && canonicalScopePath(item.root) === canonicalScopePath(scope.root)
    && validCommentPath(item.path) && validVersion(item.version)
    && (item.side === "old" || item.side === "new") && line(item.startLine) && line(item.endLine) && (item.endLine as number) >= (item.startLine as number)
    && typeof item.excerpt === "string" && typeof item.body === "string" && !!item.body.trim() && item.body.length <= MAX_REVIEW_COMMENT_BODY && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt));
}

function validNote(value: unknown, scope: CommentScope): value is NoteComment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.kind === "note" && typeof item.id === "string" && !!item.id && item.projectId === scope.projectId && typeof item.root === "string" && !!canonicalScopePath(item.root) && canonicalScopePath(item.root) === canonicalScopePath(scope.root)
    && validCommentPath(item.path) && typeof item.excerpt === "string" && item.excerpt.length <= MAX_EXCERPT + 2
    && (item.offset === undefined || (Number.isSafeInteger(item.offset) && (item.offset as number) >= 0))
    && typeof item.body === "string" && !!item.body.trim() && item.body.length <= MAX_REVIEW_COMMENT_BODY && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt));
}

function validPage(value: unknown, scope: CommentScope): value is PageComment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>, finite = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number), text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
  const root = typeof item.root === "string" ? item.root : "", url = typeof item.url === "string" ? item.url : "", body = typeof item.body === "string" ? item.body : "";
  const viewport = item.viewport as Record<string, unknown> | undefined;
  if (item.kind !== "page" || !text(item.id, 200) || !item.id || item.projectId !== scope.projectId || !root || canonicalScopePath(root) !== canonicalScopePath(scope.root) || !text(url, 2048) || (!/^https?:\/\//i.test(url) && !isLocalHtmlPreviewUrl(url)) || !text(item.title, 200) || !viewport || !finite(viewport.width) || !finite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 || viewport.width > 10000 || viewport.height > 10000 || !item.target || typeof item.target !== "object" || !text(body, MAX_REVIEW_COMMENT_BODY) || !body.trim() || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) return false;
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
  const styleMap=(value:unknown,limit:number)=>value===undefined||!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value as Record<string,unknown>).length<=limit&&Object.entries(value as Record<string,unknown>).every(([key,item])=>text(key,80)&&!!key&&text(item,1000));
  const sourceValid=(value:unknown)=>value===undefined||!!value&&typeof value==='object'&&text((value as Record<string,unknown>).file,400)&&!!(value as Record<string,unknown>).file&&["react","vue","svelte","attribute"].includes(String((value as Record<string,unknown>).framework))&&((value as Record<string,unknown>).line===undefined||(Number.isSafeInteger((value as Record<string,unknown>).line)&&(value as Record<string,unknown>).line as number>=1))&&((value as Record<string,unknown>).column===undefined||(Number.isSafeInteger((value as Record<string,unknown>).column)&&(value as Record<string,unknown>).column as number>=1));
  const element=(value:unknown)=>{if(!value||typeof value!=='object')return false;const candidate=value as Record<string,unknown>,box=candidate.rect as Record<string,unknown>|undefined,attributes=candidate.attributes;return candidate.type==='element'&&text(candidate.selector,500)&&!!candidate.selector&&text(candidate.tag,80)&&!!candidate.tag&&text(candidate.label,160)&&!!candidate.label&&(candidate.text===undefined||text(candidate.text,200))&&text(candidate.html,600)&&!!attributes&&typeof attributes==='object'&&!Array.isArray(attributes)&&Object.entries(attributes as Record<string,unknown>).every(([key,item])=>text(key,80)&&text(item,300))&&!!box&&finite(box.x)&&finite(box.y)&&finite(box.width)&&finite(box.height)&&sourceValid(candidate.source)&&(candidate.components===undefined||Array.isArray(candidate.components)&&candidate.components.length<=6&&candidate.components.every(item=>text(item,80)&&!!item))&&styleMap(candidate.computedStyles,6)&&styleMap(candidate.styles,300);};
  const edits=(value:unknown,kind:'css'|'text')=>value===undefined||Array.isArray(value)&&value.length<=80&&value.every(edit=>!!edit&&typeof edit==='object'&&text((edit as Record<string,unknown>).before,1000)&&text((edit as Record<string,unknown>).after,1000)&&text((edit as Record<string,unknown>)[kind==='css'?'property':'selector'],kind==='css'?120:500));
  if(!styleMap(target.computedStyles,6)||!styleMap(target.styles,300)||!edits(item.cssEdits,'css')||!edits(item.textEdits,'text')||(item.toChat!==undefined&&typeof item.toChat!=='boolean')||(item.elements!==undefined&&(!Array.isArray(item.elements)||item.elements.length>8||!item.elements.every(element))))return false;
  if (target.type === "element") return element(target);
  return target.type === "area" && Array.isArray(target.elements) && target.elements.length <= 8 && target.elements.every(item => text(item, 160) && !!item);
}
function assetPaths(comment: ReviewComment): string[] { return isPageComment(comment) && comment.shot ? [comment.shot.path] : []; }
function storedScope(scope: CommentScope): CommentScope { return { projectId: scope.projectId, root: canonicalScopePath(scope.root) ?? scope.root }; }
function legacyScope(storageKey: string): CommentScope | undefined {
  if (!storageKey.startsWith(LEGACY_PREFIX)) return undefined;
  const body = storageKey.slice(LEGACY_PREFIX.length), separator = body.indexOf(":");
  if (separator <= 0) return undefined;
  const projectId = body.slice(0, separator), root = body.slice(separator + 1);
  return projectId && root ? { projectId, root } : undefined;
}
async function importLegacyComments(): Promise<void> {
  const store = (() => { try { return globalThis.localStorage; } catch { return undefined; } })();
  const entries: { storageKey: string; scope: CommentScope; comments: ReviewComment[] }[] = [];
  if (store) for (let index = 0; index < store.length; index++) {
    const storageKey = store.key(index); if (!storageKey) continue;
    const scope = legacyScope(storageKey); if (!scope) continue;
    try { const value: unknown = JSON.parse(store.getItem(storageKey) ?? "[]"); const comments = Array.isArray(value) ? value.filter(item => item && typeof item === "object" && (item as Record<string, unknown>).kind === "page" ? validPage(item, scope) : valid(item, scope)).slice(0, MAX_FILE_COMMENTS) : []; entries.push({ storageKey, scope, comments }); } catch { /* Leave malformed legacy data untouched. */ }
  }
  const drafts = entries.flatMap(({ scope, comments }) => comments.map(comment => ({ draftId: comment.id, scopeProjectId: scope.projectId, scopeRoot: storedScope(scope).root, draft: comment, assetPaths: assetPaths(comment) })));
  // The transport caps frames at 8 MiB. A bounded batch leaves space for framing and an individual draft is itself
  // runtime-bounded; only the final acknowledged batch writes the durable import marker.
  const batches = Array.from({ length: Math.max(1, Math.ceil(drafts.length / LEGACY_IMPORT_BATCH)) }, (_, index) => drafts.slice(index * LEGACY_IMPORT_BATCH, (index + 1) * LEGACY_IMPORT_BATCH));
  for (let index = 0; index < batches.length; index++) await request("reviewDrafts.importLegacy", { marker: LEGACY_MARKER, drafts: batches[index]!, complete: index === batches.length - 1, operationId: operationId() });
  // Do not discard migration evidence until the runtime commits its idempotent marker.
  if (store) for (const { storageKey } of entries) store.removeItem(storageKey);
}
async function ensureLegacyImported(): Promise<void> {
  legacyImport ??= importLegacyComments().catch(error => { legacyImport = undefined; throw error; });
  return legacyImport;
}
/** Start the idempotent legacy import before maintenance or backup work observes owned review data. */
export const ensureReviewCommentsImported = ensureLegacyImported;
function rowsFor(scope: CommentScope, rows: Awaited<ReturnType<typeof request<"reviewDrafts.list">>>["drafts"]): ReviewComment[] {
  const comments: ReviewComment[] = [];
  for (const row of rows) {
    const value = row.draft;
    const kind = value && typeof value === "object" ? (value as Record<string, unknown>).kind : undefined;
    if (value && typeof value === "object" && (kind === "page" ? validPage(value, scope) : kind === "note" ? validNote(value, scope) : valid(value, scope))) { revisions.set(row.draftId, row.revision); comments.push(value as ReviewComment); }
  }
  return comments.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
}
export async function loadReviewComments(scope: CommentScope): Promise<ReviewComment[]> {
  await ensureLegacyImported();
  const stored = storedScope(scope), all = [] as Awaited<ReturnType<typeof request<"reviewDrafts.list">>>["drafts"];
  let after: string | undefined;
  do { const rows = await request("reviewDrafts.list", { scopeProjectId: stored.projectId, scopeRoot: stored.root, ...(after ? { after } : {}) }); all.push(...rows.drafts); after = rows.nextAfter; } while (after);
  return rowsFor(scope, all);
}
export async function loadFileComments(scope: CommentScope): Promise<FileComment[]> { return (await loadReviewComments(scope)).filter(isLineComment); }
async function put(scope: CommentScope, comment: ReviewComment, expectedRevision: number): Promise<void> {
  if (isPageComment(comment) && comment.shot) comment = { ...comment, shot: await persistRemotePageShot(comment.shot, comment.provenance?.sessionId, scope.projectId, scope.root) };
  const stored = storedScope(scope), result = await request("reviewDrafts.upsert", { draftId: comment.id, scopeProjectId: stored.projectId, scopeRoot: stored.root, draft: comment, assetPaths: assetPaths(comment), expectedRevision, operationId: operationId() });
  if (result.status === "conflict") { if (result.draft) revisions.set(result.draft.draftId, result.draft.revision); await loadReviewComments(scope); throw new Error("review_comments_conflict"); }
  revisions.set(result.draft.draftId, result.draft.revision);
}
export async function addFileComment(input: Omit<FileComment, "id" | "createdAt" | "excerpt"> & { text: string }): Promise<FileComment[]> {
  const body = input.body.trim();
  if (!body) throw new Error("review_comment_empty");
  if (body.length > MAX_REVIEW_COMMENT_BODY) throw new Error("review_comment_too_long");
  const scope = { projectId: input.projectId, root: input.root }, comments = await loadReviewComments(scope);
  if (comments.length >= MAX_FILE_COMMENTS) throw new Error("review_comments_full");
  const { text, ...rest } = input, comment: FileComment = { ...rest, body, excerpt: reviewExcerpt(text), id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await put(scope, comment, 0); return await loadFileComments(scope);
}
export async function removeFileComments(scope: CommentScope, ids: readonly string[]): Promise<FileComment[]> {
  const expected = new Map(revisions);
  const files = await loadFileComments(scope);
  await removeIds(scope, files.filter(comment => ids.includes(comment.id)).map(comment => comment.id), expected); return await loadFileComments(scope);
}
export function isPageComment(comment: ReviewComment): comment is PageComment { return "kind" in comment && comment.kind === "page"; }
export function isNoteComment(comment: ReviewComment): comment is NoteComment { return "kind" in comment && comment.kind === "note"; }
/** Comments anchored to lines: the ones editors mark and reopen at a line. */
export function isLineComment(comment: ReviewComment): comment is FileComment { return !("kind" in comment); }
/** A comment on a whole file (no `text`) or on a quoted selection, from a view without line numbers. */
export async function addNoteComment(input: CommentScope & { path: string; text?: string; offset?: number; body: string }): Promise<ReviewComment[]> {
  const body = input.body.trim();
  if (!body) throw new Error("review_comment_empty");
  if (body.length > MAX_REVIEW_COMMENT_BODY) throw new Error("review_comment_too_long");
  const scope = { projectId: input.projectId, root: input.root }, comments = await loadReviewComments(scope);
  if (comments.length >= MAX_FILE_COMMENTS) throw new Error("review_comments_full");
  const comment: NoteComment = { kind: "note", projectId: input.projectId, root: input.root, path: input.path, excerpt: input.text?.trim() ? reviewExcerpt(input.text) : "", ...(input.offset === undefined ? {} : { offset: input.offset }), body, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await put(scope, comment, 0); return await loadReviewComments(scope);
}
export async function addPageComment(input: CommentScope & PagePick & { body: string; provenance?: PageCommentProvenance }): Promise<ReviewComment[]> {
  const body = input.body.trim();
  if (!body) throw new Error("review_comment_empty");
  if (body.length > MAX_REVIEW_COMMENT_BODY) throw new Error("review_comment_too_long");
  const scope = { projectId: input.projectId, root: input.root }, comments = await loadReviewComments(scope);
  if (comments.length >= MAX_FILE_COMMENTS) throw new Error("review_comments_full");
  const { body: _body, ...pick } = input, comment: PageComment = { ...pick, kind: "page", body, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await put(scope, comment, 0); return await loadReviewComments(scope);
}
export async function removeReviewComments(scope: CommentScope, ids: readonly string[]): Promise<ReviewComment[]> {
  return removeIds(scope, ids, new Map(revisions));
}
async function removeIds(scope: CommentScope, ids: readonly string[], expected: ReadonlyMap<string, number>): Promise<ReviewComment[]> {
  await ensureLegacyImported();
  for (const id of ids) {
    const result = await request("reviewDrafts.delete", { draftId: id, expectedRevision: expected.get(id) ?? 0, operationId: operationId() });
    if (result.status === "conflict") { if (result.draft) revisions.set(result.draft.draftId, result.draft.revision); await loadReviewComments(scope); throw new Error("review_comments_conflict"); }
    revisions.set(id, result.revision);
  }
  return await loadReviewComments(scope);
}
/** Remove comments after their screenshot files have been transferred to a chat composer. */
export async function releaseReviewComments(scope: CommentScope, ids: readonly string[]): Promise<ReviewComment[]> {
  return removeReviewComments(scope, ids);
}
export function subscribeFileComments(scope: CommentScope, listener: () => void): () => void {
  return subscribeEvents(event => { const data = event.data as { kind?: unknown } | undefined; if (event.event === "state.changed" && data?.kind === "reviewDrafts") listener(); });
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
const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);
/** A note's place: the file reference, then its large-file position, or "whole file" when it quotes nothing. */
export function noteCommentPlace(comment: Pick<NoteComment, "path" | "excerpt" | "offset">, roots: Roots, zh: boolean): string {
  const reference = formatAgentReference({ path: referencePath(comment.path, roots.fileRoot, roots.sessionRoot) });
  if (comment.offset !== undefined) return reference + (zh ? `（约 ${mib(comment.offset)} MiB 处）` : ` (around ${mib(comment.offset)} MiB)`);
  return comment.excerpt ? reference : reference + (zh ? "（整个文件）" : " (whole file)");
}
export function noteCommentShortPlace(comment: Pick<NoteComment, "path" | "excerpt" | "offset">, zh: boolean): string {
  const name = comment.path.slice(Math.max(comment.path.lastIndexOf("/"), comment.path.lastIndexOf("\\")) + 1);
  if (comment.offset !== undefined) return `${name} · ${zh ? `约 ${mib(comment.offset)} MiB` : `~${mib(comment.offset)} MiB`}`;
  return `${name} · ${comment.excerpt ? (zh ? "选中内容" : "selection") : (zh ? "整个文件" : "whole file")}`;
}
export function formatFileComments(comments: readonly (FileComment | NoteComment)[], roots: Roots, zh: boolean): string {
  const output = [zh ? "审查意见：" : "Review comments:"];
  for (const path of new Set(comments.map(comment => comment.path))) for (const comment of comments.filter(item => item.path === path)) {
    const [first, ...rest] = comment.body.split(/\r?\n/);
    output.push(`- ${isNoteComment(comment) ? noteCommentPlace(comment, roots, zh) : fileCommentPlace(comment, roots, zh)} — ${first}`, ...rest.map(line => `  ${line}`));
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
  const { target } = comment, rect = target.rect, position = `${Math.round(rect.width)}×${Math.round(rect.height)} ${zh ? "位于" : "at"} (${Math.round(rect.x)}, ${Math.round(rect.y)})`, shot = comment.shot ? `${zh ? " · 截图：" : " · Screenshot: "}${comment.shot.path} [shot:${comment.shot.id}]` : "";
  if (target.type === "area") {
    const contains = target.elements.length ? (zh ? `。包含：${target.elements.map(item => `“${item}”`).join("、")}` : `. Contains: ${target.elements.map(item => `"${item}"`).join(", ")}`) : "";
    return [`- [${reference}] ${pageCommentLabel(target, zh)} ${zh ? "位于" : "at"} (${Math.round(rect.x)}, ${Math.round(rect.y)})${contains}`, `  ${zh ? "截图：" : "Screenshot: "}${comment.shot?.path ?? (zh ? "无" : "none")}${comment.shot?` [shot:${comment.shot.id}]`:''}`];
  }
  const output = [`- [${reference}] ${pageCommentLabel(target, zh)} (${target.selector})`];
  if (target.source) {
    const source = `${target.source.file}${target.source.line ? `:${target.source.line}${target.source.column ? `:${target.source.column}` : ""}` : ""}`, components = target.components?.length ? ` (${target.source.framework === "react" ? "React" : target.source.framework === "vue" ? "Vue" : target.source.framework === "svelte" ? "Svelte" : target.source.framework}: ${target.components.join(" › ")})` : "";
    output.push(`  ${zh ? "来源：" : "Source: "}${source}${components}`);
  }
  else if (target.components?.length) output.push(`  ${zh ? "组件：" : "Components: "}${target.components.join(" › ")}`);
  const attributes = Object.entries(target.attributes).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ");
  if (attributes) output.push(`  ${zh ? "属性：" : "Attributes: "}${attributes}`);
  const all=[target,...(comment.elements??[])].filter((element,index,items)=>items.findIndex(other=>other.selector===element.selector)===index);
  for(const [index,element] of all.entries())if(index){
    const prefix=`  ${zh?'关联元素':'Related element'} ${index+1}: `;
    const relatedAttributes=Object.entries(element.attributes).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join(' ');
    output.push(`${prefix}${element.label} (${element.selector})`, `    HTML: ${element.html}`, `    ${zh?'边框':'Box'}: ${Math.round(element.rect.width)}×${Math.round(element.rect.height)} ${zh?'位于':'at'} (${Math.round(element.rect.x)}, ${Math.round(element.rect.y)})`);
    if(relatedAttributes)output.push(`    ${zh?'属性':'Attributes'}: ${relatedAttributes}`);
    if(element.source)output.push(`    ${zh?'来源':'Source'}: ${element.source.file}${element.source.line?`:${element.source.line}${element.source.column?`:${element.source.column}`:''}`:''}`);
    if(element.components?.length)output.push(`    ${zh?'组件':'Components'}: ${element.components.join(' › ')}`);
    if(element.computedStyles&&Object.keys(element.computedStyles).length)output.push(`    ${zh?'计算样式':'Computed styles'}: ${Object.entries(element.computedStyles).map(([property,value])=>`${property}: ${value}`).join('; ')}`);
  }
  if(target.computedStyles&&Object.keys(target.computedStyles).length)output.push(`  ${zh?'计算样式':'Computed styles'}: ${Object.entries(target.computedStyles).map(([property,value])=>`${property}: ${value}`).join('; ')}`);
  for(const edit of comment.cssEdits??[])output.push(`  CSS ${edit.property}: ${JSON.stringify(edit.before)} → ${JSON.stringify(edit.after)}`);
  for(const edit of comment.textEdits??[])output.push(`  ${zh?'文本编辑':'Text edit'} ${edit.selector}: ${JSON.stringify(edit.before)} → ${JSON.stringify(edit.after)}`);
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
  const files = comments.filter((comment): comment is FileComment | NoteComment => !isPageComment(comment)), pages = comments.filter(isPageComment);
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
