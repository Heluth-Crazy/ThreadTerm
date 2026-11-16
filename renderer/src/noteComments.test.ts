import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addFileComment, addNoteComment, formatFileComments, formatReviewComments, isLineComment, isNoteComment, loadFileComments, loadReviewComments, noteCommentShortPlace, type CommentScope, type NoteComment } from "./reviewComments";

// Comments without lines (owner 2026-11-15): whole-file and quoted-selection comments from views that have no line
// numbers — large-file windows, rendered previews, Word documents, images — inside or outside the workspace.
type Row = { draftId: string; scopeProjectId?: string; scopeRoot?: string; draft: unknown; revision: number; deleted?: boolean; updatedAt: string };
const rows = new Map<string, Row>();
let sequence = 0;
const bridge = { request: async (method: string, params: Record<string, unknown>) => {
  if (method === "reviewDrafts.importLegacy") return { imported: false, complete: true };
  if (method === "reviewDrafts.list") return { drafts: [...rows.values()].filter(row => !row.deleted && row.scopeProjectId === params.scopeProjectId && row.scopeRoot === params.scopeRoot) };
  const id = params.draftId as string, current = rows.get(id), expected = params.expectedRevision as number;
  if ((current?.revision ?? 0) !== expected) return { status: "conflict", draft: current ?? null };
  if (method === "reviewDrafts.upsert") {
    const draft = { ...params.draft as Record<string, unknown>, createdAt: new Date(1700000000000 + sequence++).toISOString() };
    const row = { draftId: id, scopeProjectId: params.scopeProjectId as string, scopeRoot: params.scopeRoot as string, draft, revision: expected + 1, updatedAt: "now" };
    rows.set(id, row); return { status: "ok", draft: row };
  }
  if (method === "reviewDrafts.delete") { rows.set(id, { ...(current ?? { draftId: id, draft: {} }), revision: expected + 1, deleted: true, updatedAt: "now" }); return { status: "deleted", draftId: id, revision: expected + 1 }; }
  throw new Error(method);
}, onEvent: () => () => {} };
test.beforeEach(() => { rows.clear(); sequence = 0; (globalThis as unknown as { window: unknown }).window = { threadterm: bridge }; });
const scope: CommentScope = { projectId: "project", root: join(tmpdir(), "threadterm-note-comments") };
const roots = { fileRoot: scope.root, sessionRoot: scope.root };
const outside = process.platform === "win32" ? "D:\\logs\\app.log" : "/var/log/app.log";

test("a whole-file note is stored, kept out of line marks and sent as the whole file", async () => {
  await addNoteComment({ ...scope, path: "docs/readme.md", body: "Rewrite the intro" });
  const [note] = await loadReviewComments(scope);
  assert.ok(note && isNoteComment(note) && !isLineComment(note));
  assert.equal(note.excerpt, "");
  assert.deepEqual(await loadFileComments(scope), [], "line-marking views never see a note");
  assert.equal(formatReviewComments([note], roots, false), "Review comments:\n- docs/readme.md (whole file) — Rewrite the intro");
  assert.equal(formatReviewComments([note], roots, true), "审查意见：\n- docs/readme.md（整个文件） — Rewrite the intro");
  assert.equal(noteCommentShortPlace(note, false), "readme.md · whole file");
});

test("a large-file selection keeps its byte offset and quotes the selected text", async () => {
  await addNoteComment({ ...scope, path: outside, text: "ERROR timeout after 30s\nretrying", offset: 1258291, body: "Why does this time out?" });
  const [note] = await loadReviewComments(scope) as NoteComment[];
  assert.equal(note.offset, 1258291);
  assert.equal(note.excerpt, "ERROR timeout after 30s …");
  assert.equal(formatReviewComments([note], roots, false), `Review comments:\n- ${outside.replace(/\\/g, "/")} (around 1.20 MiB) — Why does this time out?\n  > ERROR timeout after 30s …`);
  assert.equal(noteCommentShortPlace(note, false), "app.log · ~1.20 MiB");
  assert.equal(noteCommentShortPlace(note, true), "app.log · 约 1.20 MiB");
});

test("a quoted preview selection has no position, and line comments keep their format next to notes", async () => {
  await addFileComment({ ...scope, path: "src/a.ts", version: { kind: "file" }, side: "new", startLine: 3, endLine: 3, text: "return a + b", body: "Add one" });
  await addNoteComment({ ...scope, path: "docs/guide.md", text: "Install with npm", body: "Mention pnpm too" });
  const comments = await loadReviewComments(scope), line = comments.filter(isLineComment), note = comments.find(isNoteComment)!;
  assert.equal(noteCommentShortPlace(note, false), "guide.md · selection");
  assert.equal(formatReviewComments(line, roots, false), formatFileComments(line, roots, false), "line-only output is unchanged");
  assert.equal(formatReviewComments(comments, roots, false), "Review comments:\n- src/a.ts:3 — Add one\n  > return a + b\n- docs/guide.md — Mention pnpm too\n  > Install with npm");
});

test("stored notes with a bad shape are ignored", async () => {
  const base = { kind: "note", projectId: scope.projectId, root: scope.root, path: "docs/a.md", excerpt: "", body: "Fix it", createdAt: new Date(1700000000000).toISOString() };
  const bad = [
    { ...base, id: "no-body", body: " " },
    { ...base, id: "negative-offset", offset: -1 },
    { ...base, id: "fraction-offset", offset: 1.5 },
    { ...base, id: "escaping-path", path: "../secret.md" },
    { ...base, id: "long-excerpt", excerpt: "x".repeat(400) },
    { ...base, id: "other-project", projectId: "elsewhere" },
  ];
  await addNoteComment({ ...scope, path: "docs/first.md", body: "Kept" });
  const stored = [...rows.values()][0]!, first = (stored.draft as NoteComment).id;
  for (const draft of [...bad, { ...base, id: "good", offset: 0 }]) rows.set(draft.id, { ...stored, draftId: draft.id, draft });
  assert.deepEqual((await loadReviewComments(scope)).map(comment => comment.id).sort(), [first, "good"].sort());
});

test("a note needs a body and respects the per-folder limit", async () => {
  await assert.rejects(addNoteComment({ ...scope, path: "docs/a.md", body: "   " }), /review_comment_empty/);
  await assert.rejects(addNoteComment({ ...scope, path: "docs/a.md", body: "x".repeat(4001) }), /review_comment_too_long/);
});
