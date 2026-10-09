import assert from "node:assert/strict";
import test from "node:test";
import { flashPageComment, registerPagePreview } from "./pageComments";
import { addFileComment, addPageComment, formatFileComments, formatReviewComments, isPageComment, loadFileComments, loadReviewComments, pageCommentLabel, pageCommentLocation, pageTargetRef, releaseReviewComments, removeFileComments, removeReviewComments, type CommentScope, type PageComment } from "./reviewComments";

class MemoryStore { private values = new Map<string, string>(); getItem(key: string) { return this.values.get(key) ?? null; } setItem(key: string, value: string) { this.values.set(key, value); } removeItem(key: string) { this.values.delete(key); } keys() { return [...this.values.keys()]; } }
const scope: CommentScope = { projectId: "project", root: "C:/project" };
const element = (body = "Make it blue"): Omit<PageComment, "id" | "kind" | "createdAt" | "projectId" | "root" | "body"> => ({ url: "http://localhost:5173/cart", title: "Cart · Shop", viewport: { width: 1280, height: 720 }, target: { type: "element", selector: "#save", tag: "button", label: 'button "Save changes"', attributes: { id: "save" }, html: '<button id="save">Save changes</button>', rect: { x: 40, y: 100, width: 136, height: 43 }, source: { file: "src/Cart.tsx", line: 42, framework: "react" }, components: ["CartFooter", "Cart"] }, shot: { id: "shot-1", path: "C:/shots/shot-1.png", width: 400, height: 200, thumbnail: "data:image/jpeg;base64,AA==" } });
const fileInput = { ...scope, path: "src/a.ts", version: { kind: "file" } as const, side: "new" as const, startLine: 1, endLine: 1, text: "const a = 1", body: "Use a const" };

test("legacy entries remain file comments and mixed storage preserves both kinds", () => {
  const store = new MemoryStore();
  addFileComment(fileInput, store);
  addPageComment({ ...scope, ...element(), body: "Make it blue" }, store);
  assert.equal(loadFileComments(scope, store).length, 1);
  assert.equal(loadReviewComments(scope, store).length, 2);
  assert.ok(isPageComment(loadReviewComments(scope, store)[1]));
  addFileComment({ ...fileInput, path: "src/b.ts" }, store);
  assert.equal(loadReviewComments(scope, store).length, 3);
});

test("file removal cannot accidentally remove a page comment with the same requested id", () => {
  const store = new MemoryStore();
  const [page] = addPageComment({ ...scope, ...element(), body: "page" }, store).filter(isPageComment);
  assert.equal(loadFileComments(scope, store).length, 0);
  assert.equal(removeReviewComments(scope, [], store).length, 1);
  // This is the legacy file-only operation under test; its page row must remain intact.
  removeFileComments(scope, [page.id], store);
  assert.equal(loadReviewComments(scope, store).length, 1);
});

test("the shared total cap applies across file and page comments", () => {
  const store = new MemoryStore();
  for (let i = 0; i < 200; i++) addPageComment({ ...scope, ...element(), url: `http://localhost/${i}`, body: "comment" }, store);
  assert.throws(() => addFileComment(fileInput, store), /review_comments_full/);
});

test("malformed persisted page records are ignored before they reach render helpers", () => {
  const store = new MemoryStore(); addPageComment({ ...scope, ...element(), body: "comment" }, store);
  const key = store.keys()[0], [stored] = JSON.parse(store.getItem(key)!);
  store.setItem(key, JSON.stringify([{ ...stored, viewport: { width: 0, height: 720 } }, { ...stored, target: { ...stored.target, attributes: { id: 42 } } }, { ...stored, shot: { ...stored.shot, thumbnail: "nope" } }]));
  assert.deepEqual(loadReviewComments(scope, store), []);
});

test("page provenance is optional for legacy records but rejects malformed owner identity", () => {
  const store = new MemoryStore();
  addPageComment({ ...scope, ...element(), body: "legacy" }, store);
  const storageKey = store.keys()[0];
  const raw = JSON.parse(store.getItem(storageKey) ?? "[]");
  raw.push({ ...raw[0], id: "bad-provenance", provenance: { previewId: "", sessionId: "session-a" } });
  store.setItem(storageKey, JSON.stringify(raw));
  const comments = loadReviewComments(scope, store).filter(isPageComment);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].provenance, undefined);
});

test("a malformed page-kind record cannot fall through the legacy file validator", () => {
  const store = new MemoryStore(); addFileComment(fileInput, store);
  const key = store.keys()[0], [stored] = JSON.parse(store.getItem(key)!);
  store.setItem(key, JSON.stringify([{ ...stored, kind: "page" }]));
  assert.deepEqual(loadReviewComments(scope, store), []);
});

test("removing page comments deletes their screenshot ids and release keeps transferred images", () => {
  const store = new MemoryStore(), calls: string[][] = [];
  const [comment] = addPageComment({ ...scope, ...element(), body: "comment" }, store).filter(isPageComment);
  removeReviewComments(scope, [comment.id], store, ids => { calls.push([...ids]); });
  assert.deepEqual(calls, [["shot-1"]]);
  const [transferred] = addPageComment({ ...scope, ...element(), body: "transferred" }, store).filter(isPageComment);
  releaseReviewComments(scope, [transferred.id], store);
  assert.deepEqual(calls, [["shot-1"]]);
});

test("file-only review formatting is the historic formatter byte for byte", () => {
  const store = new MemoryStore(), files = addFileComment(fileInput, store);
  const roots = { fileRoot: "C:/project" };
  assert.equal(formatReviewComments(files, roots, false), formatFileComments(files, roots, false));
  assert.equal(formatReviewComments(files, roots, true), formatFileComments(files, roots, true));
});

test("page formatting includes element and area evidence in English and Chinese", () => {
  const store = new MemoryStore();
  addPageComment({ ...scope, ...element(), body: "Make it the primary blue button." }, store);
  addPageComment({ ...scope, url: "http://localhost:5173/cart", title: "Cart · Shop", viewport: { width: 1280, height: 720 }, target: { type: "area", rect: { x: 0, y: 0, width: 320, height: 180 }, elements: ['header "Shop"', 'nav "Main"'] }, body: "Too much whitespace." }, store);
  const english = formatReviewComments(loadReviewComments(scope, store), { fileRoot: "C:/project" }, false), chinese = formatReviewComments(loadReviewComments(scope, store), { fileRoot: "C:/project" }, true);
  assert.match(english, /Page context.*viewport 1280×720/); assert.match(english, /Source: src\/Cart.tsx:42 \(React: CartFooter › Cart\)/); assert.match(english, /Attributes: id="save"/); assert.ok(english.includes("Screenshot: C:/shots/shot-1.png")); assert.match(english, /Area 320×180/);
  assert.match(chinese, /页面评论/); assert.match(chinese, /来源：src\/Cart.tsx:42/); assert.match(chinese, /区域 320×180/);
  for (const message of [english, chinese]) {
    const bodyIndex = message.indexOf('Make it the primary blue button.');
    assert.ok(bodyIndex > message.lastIndexOf('shot-1.png'));
    assert.ok(bodyIndex > message.indexOf('320×180'));
    assert.ok(message.endsWith('- [P2] Too much whitespace.'));
  }
});

test("all page instructions follow all page references, with global IDs and intact multiline bodies", () => {
  const store = new MemoryStore();
  addFileComment(fileInput, store);
  addPageComment({ ...scope, ...element(), body: "First change\r\nKeep the label.\n\nKeep keyboard focus." }, store);
  addPageComment({ ...scope, ...element(), url: "http://localhost:5173/profile", body: "Second change" }, store);
  addPageComment({ ...scope, ...element(), target: { type: "area", rect: { x: 3, y: 4, width: 90, height: 50 }, elements: ['header "Cart"'] }, body: "Third change" }, store);
  const comments = loadReviewComments(scope, store), before = JSON.stringify(comments);
  for (const zh of [false, true]) {
    const message = formatReviewComments(comments, { fileRoot: "C:/project" }, zh);
    const heading = zh ? "页面评论 / 修改要求（对应上面的编号）：" : "Page comments / requested changes (match the references above):";
    const [context, requirements] = message.split(heading);
    assert.ok(context.startsWith(formatFileComments(loadFileComments(scope, store), { fileRoot: "C:/project" }, zh)));
    assert.ok(context.includes('/profile'));
    assert.match(context, /\[P1\].*#save/);
    assert.match(context, /\[P2\].*#save/);
    assert.match(context, /\[P3\].*90×50/);
    assert.ok(!context.includes('First change') && !context.includes('Second change') && !context.includes('Third change'));
    assert.equal(requirements, '\n- [P1] First change\n  Keep the label.\n  \n  Keep keyboard focus.\n- [P2] Second change\n- [P3] Third change');
    assert.ok(!requirements.includes('Screenshot:') && !requirements.includes('截图：'));
  }
  assert.equal(JSON.stringify(comments), before);
});

test("same URL comments keep separate immutable page-owner context in the draft", () => {
  const store = new MemoryStore();
  addPageComment({ ...scope, ...element(), body: "Change owner A", provenance: { previewId: "preview-a", documentId: "document-a", sessionId: "session-a", sessionTitle: "Closed owner", providerId: "codex", tabId: "tab-a", navigation: 2 } }, store);
  addPageComment({ ...scope, ...element(), body: "Change owner B", provenance: { previewId: "preview-b", documentId: "document-b", sessionId: "session-b", providerId: "fixture", tabId: "tab-b", navigation: 7 } }, store);
  const message = formatReviewComments(loadReviewComments(scope, store), { fileRoot: "C:/project" }, false);
  assert.equal((message.match(/Page context — http:\/\/localhost:5173\/cart/g) ?? []).length, 2);
  for (const expected of ["Source session: Closed owner (codex) [session-a]", "Preview ID: preview-a", "Document ID: document-a", "Page tab ID: tab-a", "Navigation generation: 2", "Source session: session-b (fixture)", "Preview ID: preview-b", "Document ID: document-b", "Page tab ID: tab-b", "Navigation generation: 7"]) assert.ok(message.includes(expected));
});

test("page display helpers expose safe labels, locations, and target references", () => {
  const picked = element().target, area: PageComment["target"] = { type: "area", rect: { x: 1, y: 2, width: 3, height: 4 }, elements: [] };
  assert.equal(pageCommentLabel(picked, false), 'button "Save changes"'); assert.equal(pageCommentLabel(area, true), "区域 3×4");
  assert.equal(pageCommentLocation("https://example.test/a?x=1"), "example.test/a"); assert.deepEqual(pageTargetRef(picked), { selector: "#save", rect: picked.rect }); assert.deepEqual(pageTargetRef(area), { rect: area.rect });
});

test("a preview registry follows immutable preview identity when a newer frame unmounts", async () => {
  const comment = { ...scope, ...element(), kind: "page" as const, id: "comment", body: "body", createdAt: new Date().toISOString(), provenance: { previewId: "preview-a", sessionId: "session-a", navigation: 1 } };
  const calls: string[] = []; (globalThis as unknown as { window: unknown }).window = { threadterm: { markPageTarget: async ({ frameName }: { frameName: string }) => { calls.push(frameName); return true; } } };
  const old = registerPagePreview("preview-a", undefined, 1, "tt-preview-old"), newest = registerPagePreview("preview-a", undefined, 1, "tt-preview-new"); newest();
  assert.equal(await flashPageComment(comment), true); assert.deepEqual(calls, ["tt-preview-old"]); old();
  assert.equal(await flashPageComment(comment), false);
  assert.equal(await flashPageComment({ ...comment, url: "" }), false);
});

test("a preview registry never crosses same-URL preview identities", async () => {
  const comment = { ...scope, ...element(), url: "http://localhost:5173/visible", kind: "page" as const, id: "visible", body: "body", createdAt: new Date().toISOString(), provenance: { previewId: "preview-a", sessionId: "session-a", navigation: 4 } }, calls: string[] = [];
  (globalThis as unknown as { window: unknown }).window = { threadterm: { markPageTarget: async ({ frameName }: { frameName: string }) => { calls.push(frameName); return true; } } };
  const older = registerPagePreview("preview-a", undefined, 4, "tt-preview-visible", () => true), newer = registerPagePreview("preview-b", undefined, 4, "tt-preview-other-session", () => true);
  assert.equal(await flashPageComment(comment), true); assert.deepEqual(calls, ["tt-preview-visible"]); older(); newer();
  registerPagePreview("preview-a", undefined, 4, "tt-preview-hidden-only", () => false);
  assert.equal(await flashPageComment(comment), false);
});

test("a preview registry rejects a stale document in the same preview", async () => {
  const comment = { ...scope, ...element(), kind: "page" as const, id: "stale", body: "body", createdAt: new Date().toISOString(), provenance: { previewId: "preview-a", documentId: "old-document", sessionId: "session-a" } };
  const calls: string[] = []; (globalThis as unknown as { window: unknown }).window = { threadterm: { markPageTarget: async ({ frameName }: { frameName: string }) => { calls.push(frameName); return true; } } };
  const stop = registerPagePreview("preview-a", "new-document", undefined, "tt-preview-new");
  assert.equal(await flashPageComment(comment), false);
  stop();
  registerPagePreview("preview-a", "old-document", undefined, "tt-preview-old");
  assert.equal(await flashPageComment(comment), true); assert.deepEqual(calls, ["tt-preview-old"]);
});

test("a preview registry rejects a stale navigation generation in the same document", async () => {
  const comment = { ...scope, ...element(), kind: "page" as const, id: "stale-navigation", body: "body", createdAt: new Date().toISOString(), provenance: { previewId: "preview-a", documentId: "document-a", navigation: 3, sessionId: "session-a" } };
  const calls: string[] = []; (globalThis as unknown as { window: unknown }).window = { threadterm: { markPageTarget: async ({ frameName }: { frameName: string }) => { calls.push(frameName); return true; } } };
  registerPagePreview("preview-a", "document-a", 4, "tt-preview-reloaded");
  assert.equal(await flashPageComment(comment), false);
  registerPagePreview("preview-a", "document-a", 3, "tt-preview-original");
  assert.equal(await flashPageComment(comment), true); assert.deepEqual(calls, ["tt-preview-original"]);
});
