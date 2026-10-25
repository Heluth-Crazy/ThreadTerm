import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addFileComment, loadReviewComments, removeReviewComments, type CommentScope } from "./reviewComments";

const scope: CommentScope = { projectId: "project", root: join(tmpdir(), "threadterm-review-drafts") };
const rows = new Map<string, { draftId: string; scopeProjectId?: string; scopeRoot?: string; draft: unknown; revision: number; deleted?: boolean; updatedAt: string }>();
(globalThis as unknown as { window: unknown }).window = { threadterm: { request: async (method: string, params: Record<string, unknown>) => {
  if (method === "reviewDrafts.importLegacy") return { imported: false, drafts: [...rows.values()] };
  if (method === "reviewDrafts.list") return { drafts: [...rows.values()].filter(row => !row.deleted && row.scopeProjectId === params.scopeProjectId && row.scopeRoot === params.scopeRoot) };
  const id = params.draftId as string, current = rows.get(id), expected = params.expectedRevision as number;
  if (method === "reviewDrafts.upsert") { if ((current?.revision ?? 0) !== expected) return { status: "conflict", draft: current ?? null }; const row = { draftId: id, scopeProjectId: params.scopeProjectId as string, scopeRoot: params.scopeRoot as string, draft: params.draft, revision: expected + 1, updatedAt: "now" }; rows.set(id, row); return { status: "ok", draft: row }; }
  if (method === "reviewDrafts.delete") { if ((current?.revision ?? 0) !== expected) return { status: "conflict", draft: current ?? null }; rows.set(id, { ...(current ?? { draftId: id, draft: {} }), revision: expected + 1, deleted: true, updatedAt: "now" }); return { status: "deleted", draftId: id, revision: expected + 1 }; }
  throw new Error(method);
}, onEvent: () => () => {} } };

test("concurrent review-comment writers keep both rows and stale deletion re-reads", async () => {
  rows.clear();
  await Promise.all(["a", "b"].map(path => addFileComment({ ...scope, path: `src/${path}.ts`, version: { kind: "file" }, side: "new", startLine: 1, endLine: 1, text: path, body: path })));
  const comments = await loadReviewComments(scope);
  assert.equal(comments.length, 2);
  const first = rows.get(comments[0]!.id)!; rows.set(first.draftId, { ...first, revision: first.revision + 1 });
  await assert.rejects(removeReviewComments(scope, [comments[0]!.id]), /review_comments_conflict/);
  assert.equal((await loadReviewComments(scope)).length, 2);
});
