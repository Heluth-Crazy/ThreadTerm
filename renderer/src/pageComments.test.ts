import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flashPageComment, registerPagePreview } from "./pageComments";
import { addFileComment, addPageComment, formatFileComments, formatReviewComments, isPageComment, loadFileComments, loadReviewComments, pageCommentLabel, pageCommentLocation, pageTargetRef, releaseReviewComments, removeFileComments, removeReviewComments, type CommentScope, type PageComment } from "./reviewComments";

type Row = {draftId:string;scopeProjectId?:string;scopeRoot?:string;draft:unknown;revision:number;deleted?:boolean;updatedAt:string};
const rows = new Map<string, Row>();
let sequence = 0, bumpOnList = false;
const bridge = { request: async (method:string, params:Record<string,unknown>) => {
  if (method === "reviewDrafts.importLegacy") return {imported:false,complete:true};
  if (method === "reviewDrafts.list") {
    const drafts=[...rows.values()].filter(row=>!row.deleted && row.scopeProjectId===params.scopeProjectId && row.scopeRoot===params.scopeRoot);
    if(bumpOnList && drafts[0]) {const row=drafts[0];rows.set(row.draftId,{...row,revision:row.revision+1});bumpOnList=false;}
    return {drafts};
  }
  const id=params.draftId as string, current=rows.get(id), expected=params.expectedRevision as number;
  if((current?.revision??0)!==expected) return {status:"conflict",draft:current??null};
  if(method === "reviewDrafts.upsert") {
    const draft={...params.draft as Record<string,unknown>,createdAt:new Date(1700000000000+sequence++).toISOString()};
    const row={draftId:id,scopeProjectId:params.scopeProjectId as string,scopeRoot:params.scopeRoot as string,draft,revision:expected+1,updatedAt:"now"};
    rows.set(id,row);return {status:"ok",draft:row};
  }
  if(method === "reviewDrafts.delete") {rows.set(id,{...(current??{draftId:id,draft:{}}),revision:expected+1,deleted:true,updatedAt:"now"});return {status:"deleted",draftId:id,revision:expected+1};}
  throw new Error(method);
}, onEvent:()=>()=>{} };
test.beforeEach(()=>{rows.clear();sequence=0;bumpOnList=false;(globalThis as unknown as {window:unknown}).window={threadterm:bridge};});
function rawDrafts(): Record<string,unknown>[] {return [...rows.values()].filter(row=>!row.deleted).map(row=>row.draft as Record<string,unknown>);}
function replaceDrafts(drafts:Record<string,unknown>[]) {
  const owner=[...rows.values()][0]!;rows.clear();
  drafts.forEach((draft,index)=>{const draftId=index===0 ? String(draft.id) : `raw-${index}`;rows.set(draftId,{...owner,draftId,draft,deleted:false});});
}
const scope: CommentScope = {projectId:"project",root:join(tmpdir(),"threadterm-page-comments")};
const element = (body = "Make it blue"): Omit<PageComment, "id" | "kind" | "createdAt" | "projectId" | "root" | "body"> => ({ url: "http://localhost:5173/cart", title: "Cart · Shop", viewport: { width: 1280, height: 720 }, target: { type: "element", selector: "#save", tag: "button", label: 'button "Save changes"', attributes: { id: "save" }, html: '<button id="save">Save changes</button>', rect: { x: 40, y: 100, width: 136, height: 43 }, source: { file: "src/Cart.tsx", line: 42, framework: "react" }, components: ["CartFooter", "Cart"] }, shot: { id: "shot-1", path: join(tmpdir(),"shots","shot-1.png"), width: 400, height: 200, thumbnail: "data:image/jpeg;base64,AA==" } });
const fileInput = { ...scope, path: "src/a.ts", version: { kind: "file" } as const, side: "new" as const, startLine: 1, endLine: 1, text: "const a = 1", body: "Use a const" };

test("legacy entries remain file comments and mixed storage preserves both kinds", async () => {
  await addFileComment(fileInput); await addPageComment({...scope,...element(),body:"Make it blue"});
  assert.equal((await loadFileComments(scope)).length,1); assert.equal((await loadReviewComments(scope)).length,2);
  assert.ok(isPageComment((await loadReviewComments(scope))[1]!)); await addFileComment({...fileInput,path:"src/b.ts"});
  assert.equal((await loadReviewComments(scope)).length,3);
});
test("file removal cannot accidentally remove a page comment with the same requested id", async () => {
  const [page]=(await addPageComment({...scope,...element(),body:"page"})).filter(isPageComment);
  assert.equal((await loadFileComments(scope)).length,0);assert.equal((await removeReviewComments(scope,[])).length,1);
  await removeFileComments(scope,[page!.id]);assert.equal((await loadReviewComments(scope)).length,1);
});
test("the shared total cap applies across file and page comments", async () => {
  for(let i=0;i<200;i++) await addPageComment({...scope,...element(),url:`http://localhost/${i}`,body:"comment"});
  await assert.rejects(addFileComment(fileInput),/review_comments_full/);
});
test("malformed persisted page records are ignored before they reach render helpers", async () => {
  await addPageComment({...scope,...element(),body:"comment"});const [stored]=rawDrafts();
  const target=stored!.target as Record<string,unknown>,shot=stored!.shot as Record<string,unknown>;
  replaceDrafts([{...stored,viewport:{width:0,height:720}},{...stored,target:{...target,attributes:{id:42}}},{...stored,shot:{...shot,thumbnail:"nope"}}]);
  assert.deepEqual(await loadReviewComments(scope),[]);
});
test("page provenance is optional for legacy records but rejects malformed owner identity", async () => {
  await addPageComment({...scope,...element(),body:"legacy"});const [stored]=rawDrafts();
  replaceDrafts([stored!,{...stored,id:"bad-provenance",provenance:{previewId:"",sessionId:"session-a"}}]);
  const comments=(await loadReviewComments(scope)).filter(isPageComment);assert.equal(comments.length,1);assert.equal(comments[0]!.provenance,undefined);
});
test("a malformed page-kind record cannot fall through the legacy file validator", async () => {
  await addFileComment(fileInput);const [stored]=rawDrafts();replaceDrafts([{...stored,kind:"page"}]);assert.deepEqual(await loadReviewComments(scope),[]);
});
test("removing page drafts releases their catalog row and transferred images stay desktop-owned", async () => {
  const [comment]=(await addPageComment({...scope,...element(),body:"comment"})).filter(isPageComment);
  await removeReviewComments(scope,[comment!.id]);assert.equal((await loadReviewComments(scope)).length,0);
  assert.equal(rows.get(comment!.id)!.deleted,true);
  const [transferred]=(await addPageComment({...scope,...element(),body:"transferred"})).filter(isPageComment);
  await releaseReviewComments(scope,[transferred!.id]);assert.equal((await loadReviewComments(scope)).length,0);
  // Physical deletion is reference-checked in desktop; the renderer never deletes screenshot files.
  assert.equal(rows.get(transferred!.id)!.deleted,true);
});
test("file-only review formatting is the historic formatter byte for byte", async () => {
  const files=await addFileComment(fileInput),roots={fileRoot:scope.root};
  assert.equal(formatReviewComments(files,roots,false),formatFileComments(files,roots,false));assert.equal(formatReviewComments(files,roots,true),formatFileComments(files,roots,true));
});
test("page formatting includes element and area evidence in English and Chinese", async () => {
  await addPageComment({ ...scope, ...element(), body: "Make it the primary blue button." });
  await addPageComment({ ...scope, url: "http://localhost:5173/cart", title: "Cart · Shop", viewport: { width: 1280, height: 720 }, target: { type: "area", rect: { x: 0, y: 0, width: 320, height: 180 }, elements: ['header "Shop"', 'nav "Main"'] }, body: "Too much whitespace." });
  const english = formatReviewComments((await loadReviewComments(scope)), { fileRoot: scope.root }, false), chinese = formatReviewComments((await loadReviewComments(scope)), { fileRoot: scope.root }, true);
  assert.match(english, /Page context.*viewport 1280×720/); assert.match(english, /Source: src\/Cart.tsx:42 \(React: CartFooter › Cart\)/); assert.match(english, /Attributes: id="save"/); assert.ok(english.includes(`Screenshot: ${element().shot!.path}`)); assert.match(english, /Area 320×180/);
  assert.match(chinese, /页面评论/); assert.match(chinese, /来源：src\/Cart.tsx:42/); assert.match(chinese, /区域 320×180/);
  for (const message of [english, chinese]) {
    const bodyIndex = message.indexOf('Make it the primary blue button.');
    assert.ok(bodyIndex > message.lastIndexOf('shot-1.png'));
    assert.ok(bodyIndex > message.indexOf('320×180'));
    assert.ok(message.endsWith('- [P2] Too much whitespace.'));
  }
});

test("all page instructions follow all page references, with global IDs and intact multiline bodies", async () => {
  await addFileComment(fileInput);
  await addPageComment({ ...scope, ...element(), body: "First change\r\nKeep the label.\n\nKeep keyboard focus." });
  await addPageComment({ ...scope, ...element(), url: "http://localhost:5173/profile", body: "Second change" });
  await addPageComment({ ...scope, ...element(), target: { type: "area", rect: { x: 3, y: 4, width: 90, height: 50 }, elements: ['header "Cart"'] }, body: "Third change" });
  const comments = (await loadReviewComments(scope)), before = JSON.stringify(comments);
  for (const zh of [false, true]) {
    const message = formatReviewComments(comments, { fileRoot: scope.root }, zh);
    const heading = zh ? "页面评论 / 修改要求（对应上面的编号）：" : "Page comments / requested changes (match the references above):";
    const [context, requirements] = message.split(heading);
    assert.ok(context.startsWith(formatFileComments((await loadFileComments(scope)), { fileRoot: scope.root }, zh)));
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

test("same URL comments keep separate immutable page-owner context in the draft", async () => {
  await addPageComment({ ...scope, ...element(), body: "Change owner A", provenance: { previewId: "preview-a", documentId: "document-a", sessionId: "session-a", sessionTitle: "Closed owner", providerId: "codex", tabId: "tab-a", navigation: 2 } });
  await addPageComment({ ...scope, ...element(), body: "Change owner B", provenance: { previewId: "preview-b", documentId: "document-b", sessionId: "session-b", providerId: "fixture", tabId: "tab-b", navigation: 7 } });
  const message = formatReviewComments((await loadReviewComments(scope)), { fileRoot: scope.root }, false);
  assert.equal((message.match(/Page context — http:\/\/localhost:5173\/cart/g) ?? []).length, 2);
  for (const expected of ["Source session: Closed owner (codex) [session-a]", "Preview ID: preview-a", "Document ID: document-a", "Page tab ID: tab-a", "Navigation generation: 2", "Source session: session-b (fixture)", "Preview ID: preview-b", "Document ID: document-b", "Page tab ID: tab-b", "Navigation generation: 7"]) assert.ok(message.includes(expected));
});

test("page display helpers expose safe labels, locations, and target references", async () => {
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

test("file removal conflicts when the row changes after its displayed revision", async()=>{
  const [file]=await addFileComment({...fileInput,path:"src/stale.ts"});bumpOnList=true;
  await assert.rejects(removeFileComments(scope,[file!.id]),/review_comments_conflict/);assert.equal((await loadReviewComments(scope)).length,1);
});
