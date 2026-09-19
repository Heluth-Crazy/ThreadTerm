import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldKeymap } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { go } from "@codemirror/lang-go";
import { php } from "@codemirror/lang-php";
import { sql } from "@codemirror/lang-sql";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { MergeView, getChunks } from "@codemirror/merge";

const MAX_HIGHLIGHT_BYTES = 512 * 1024;
const views = new Map();
const mergeViews = new Map();
// EditorState is intentionally memory-only: CodeMirror history contains live
// objects and must not be put into the durable JSON fixture store.
const cachedStates = new Map();
// Whole-root renders replace the focused contenteditable node. Keep this
// transient (never durable) identity so a terminal/chat completion returns
// focus only to the editor that actually had it before the render.
let focusedEditorKey = null;
let draggedTabPath = null;
let api;
let state;

const textBytes = (value) => new TextEncoder().encode(value).length;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const pathLanguage = (path) => {
  const lower = path.toLowerCase();
  const base = lower.split(/[\\/]/).pop() || lower;
  if (/\.(tsx|ts|mts|cts)$/.test(lower)) return javascript({ jsx: lower.endsWith("x"), typescript: true });
  if (/\.(jsx|js|mjs|cjs)$/.test(lower)) return javascript({ jsx: lower.endsWith("x") });
  if (/\.(json|jsonc)$/.test(lower)) return json();
  if (/\.(md|mdx|markdown)$/.test(lower)) return markdown();
  if (/\.(css|scss|sass|less)$/.test(lower)) return css();
  if (/\.(html|htm|xml|svg)$/.test(lower)) return html();
  if (lower.endsWith(".rs")) return rust();
  if (/\.(py|pyw)$/.test(lower)) return python();
  if (/\.(ya?ml)$/.test(lower)) return yaml();
  if (/\.(c|h|cc|cpp|cxx|hpp|hh)$/.test(lower)) return cpp();
  if (lower.endsWith(".java")) return java();
  if (lower.endsWith(".go")) return go();
  if (lower.endsWith(".php")) return php();
  if (lower.endsWith(".sql")) return sql();
  if (/\.(sh|bash|zsh)$/.test(lower)) return StreamLanguage.define(shell);
  if (/\.(ps1|psm1|psd1)$/.test(lower)) return StreamLanguage.define(powerShell);
  if (lower.endsWith(".toml")) return StreamLanguage.define(toml);
  if (base === "dockerfile" || base === "containerfile" || base.endsWith(".dockerfile")) return StreamLanguage.define(dockerFile);
  if (/\.(properties|ini|env)$/.test(lower) || base === ".env") return StreamLanguage.define(properties);
  return null;
};

function documentState(key, value) {
  const record = state.documents[key] || (state.documents[key] = { saved: value, draft: value, readOnly: false, mode: "edit" });
  return record;
}

// The host keeps this live object stable; obtain it through the documented API.
function refreshState() {
  state = api.featureState("editor", { documents: {}, scenarios: {} });
  state.documents ||= {};
  state.selectedPaths ||= {};
  state.tabsByTree ||= {};
  return state;
}

function fixtureFor(path, saved) {
  refreshState();
  const record = documentState(path.key, saved);
  if (state.nextSaveError) { record.saveError = true; state.nextSaveError = false; }
  if (state.nextExternal) { record.external = true; state.nextExternal = false; }
  const name = path.path.toLowerCase();
  const scene = api.store?.featureStates?.editor?.scenario || state.scenario || "";
  record.binary = name.includes("binary") || scene === "binary";
  record.large = name.includes("large") || scene === "large";
  record.readOnly = name.includes("readonly") || scene === "readonly";
  record.failed = (name.includes("unreadable") || scene === "read-failure") && !record.retried;
  return record;
}

function extensions(path, onChange, onSave, readonly) {
  const language = pathLanguage(path.path);
  return [
    lineNumbers(), foldGutter(), highlightActiveLineGutter(), history(), drawSelection(),
    indentOnInput(), bracketMatching(), closeBrackets(), rectangularSelection(), crosshairCursor(),
    highlightActiveLine(), highlightSelectionMatches(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    search({ top: true }),
    keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { onSave(); return true; } }, { key: "Mod-Shift-z", preventDefault: true, run: redo }, { key: "Ctrl-Shift-z", preventDefault: true, run: redo }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...foldKeymap, ...closeBracketsKeymap, ...searchKeymap]),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => { if (update.docChanged) onChange(update.state.doc.toString()); }),
    EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly),
    ...(language && textBytes(path.value) <= MAX_HIGHLIGHT_BYTES ? [language] : []),
  ];
}

function destroyView(key) {
  const mounted = views.get(key);
  if (!mounted) return;
  cachedStates.set(key, mounted.view.state);
  mounted.descriptor.record.view = { selection: mounted.view.state.selection.toJSON(), scrollTop: mounted.view.scrollDOM.scrollTop };
  mounted.view.destroy();
  views.delete(key);
}

// A discarded/reloaded document must not be reconstructed from the live
// CodeMirror history that was captured just before the shell rerendered.
function forgetView(key) {
  destroyView(key);
  cachedStates.delete(key);
}

function destroyMergeView(key) {
  const mounted = mergeViews.get(key);
  if (!mounted) return;
  mounted.view.destroy();
  mergeViews.delete(key);
}

function mountEditor(host, descriptor) {
  destroyView(descriptor.key);
  const record = descriptor.record;
  const initial = record.draft;
  const mounted = { descriptor, snapshot: record.view || null };
  const updateDraft = (value) => {
    record.draft = value;
    record.dirty = value !== record.saved;
    api.save();
    host.closest(".tt-editor-shell")?.querySelector("[data-testid='editor-dirty']")?.toggleAttribute("hidden", !record.dirty);
  };
  const editorExtensions = extensions({ path: descriptor.path, value: initial }, updateDraft, () => saveDocument(descriptor), record.readOnly);
  const cached = cachedStates.get(descriptor.key);
  mounted.view = new EditorView({
    state: cached ? cached.update({ effects: StateEffect.reconfigure.of(editorExtensions) }).state : EditorState.create({ doc: initial, extensions: editorExtensions }),
    parent: host,
  });
  if (mounted.snapshot) requestAnimationFrame(() => {
    // Reusing the cached EditorState already restores the selection and undo
    // history. Restoring a serialized state as a selection transaction loses
    // the history after a whole-shell rerender.
    mounted.view.scrollDOM.scrollTop = mounted.snapshot.scrollTop || 0;
  });
  views.set(descriptor.key, mounted);
  if (focusedEditorKey === descriptor.key) requestAnimationFrame(() => {
    // A dialog, settings field, or another control that intentionally gained
    // focus wins over restoration. The common render path leaves focus on body.
    const active = document.activeElement;
    if (focusedEditorKey === descriptor.key && (active === document.body || active === document.documentElement)) mounted.view.focus();
    if (focusedEditorKey === descriptor.key) focusedEditorKey = null;
  });
  return mounted;
}

function saveDocument(descriptor) {
  const record = descriptor.record;
  if (record.binary || record.large || record.failed) return api.toast("此文件尚不可编辑，不能保存。");
  if (record.readOnly) return api.toast("此演示文件为只读，不能保存。");
  if (record.external) return api.toast("检测到模拟外部更改。请选择重新载入或保留并覆盖后再保存。");
  if (record.saveError) { record.saveError = false; api.save(); return api.toast("模拟保存失败：权限被拒绝。请重试。"); }
  record.saved = record.draft;
  record.dirty = false;
  record.external = false;
  api.save();
  document.querySelectorAll('[data-testid="editor-dirty"]').forEach((node) => {
    if (node.closest('[data-editor-key]')?.dataset.editorKey === descriptor.key) node.hidden = true;
  });
  api.toast("演示草稿已保存到本原型；未写入真实文件。");
}

function fileDescriptor(context) {
  refreshState();
  const item = api.sessionById(context.ui.route.sessionId);
  if (!item) return null;
  const index = context.ui.wsFile || 0;
  const path = api.store?.featureStates?.editor?.selectedPaths?.[item.tree] || state.selectedPaths?.[item.tree] || context.path || api.projects[item.project]?.files?.[index];
  if (!path) return null;
  const key = `${item.tree}:${path}`;
  state.selectedPaths[item.tree] = path;
  const tabs = tabsFor(item);
  if (!tabs.includes(path)) tabs.push(path);
  const saved = path === context.path ? api.fileValue(item, index) : fixtureText(path);
  const record = fixtureFor({ key, path }, saved);
  return { item, index, path, key, record, binary: record.binary, large: record.large, failed: record.failed };
}

function fixtureText(path) {
  if (/\.md$/i.test(path)) return "# Saved preview fixture\n\nThis markdown is rendered locally. No request is made.\n";
  if (/\.html?$/i.test(path)) return "<!doctype html><main><h1>Saved HTML fixture</h1><p>Rendered in an inert sandbox.</p></main>";
  return "// Local prototype fixture\nexport const preview = true;\n";
}

function availablePaths(item) {
  return [...api.projects[item.project].files, "preview/saved-demo.html", "preview/developer-address.fixture.html", "preview/binary.fixture", "preview/large.fixture", "preview/unreadable.fixture"];
}

function tabsFor(item) {
  state.tabsByTree ||= {};
  return state.tabsByTree[item.tree] ||= availablePaths(item);
}

function tabKey(item, path) {
  return `${item.tree}:${path}`;
}

function closeTabPaths(item, paths, disposition = "discard") {
  const closing = new Set(paths);
  if (disposition === "save" && paths.some((path) => {
    const record = state.documents[tabKey(item, path)];
    return record?.dirty && (record.readOnly || record.external || record.saveError || record.failed);
  })) return false;
  for (const path of paths) {
    const record = state.documents[tabKey(item, path)];
    if (!record) continue;
    if (disposition === "save") {
      record.saved = record.draft;
      record.dirty = false;
    } else {
      record.draft = record.saved;
      record.dirty = false;
      forgetView(tabKey(item, path));
    }
  }
  const remaining = tabsFor(item).filter((path) => !closing.has(path));
  state.tabsByTree[item.tree] = remaining;
  if (closing.has(state.selectedPaths[item.tree])) state.selectedPaths[item.tree] = remaining[0] || "";
  if (!remaining.length) api.ui.wsTab = "terminal";
  state.pendingTabClose = null;
  api.save();
  api.render();
  return true;
}

function requestTabClose(item, paths) {
  const dirty = paths.filter((path) => state.documents[tabKey(item, path)]?.dirty);
  if (!dirty.length) return closeTabPaths(item, paths);
  state.pendingTabClose = { tree: item.tree, paths };
  api.openDialog("保留这些演示草稿吗？", "关闭前，先决定如何处理未保存的修改。", `<p class="dlg-text">${dirty.length} 份草稿包含未保存修改；这些内容只存于本原型。</p>`, '<button type="button" class="btn" data-action="close-dialog">取消</button><button type="button" class="btn btn-danger" data-action="editor-discard">放弃修改并关闭</button><button type="button" class="btn btn-primary" data-action="editor-save-close">保存并关闭</button>');
}

function previewHtml(path, value, address = "http://localhost:3000/") {
  if (path.includes("developer-address"))
    return `<iframe class="tt-preview-frame" title="开发地址演示预览" sandbox="" srcdoc="${escapeHtml(`<main><h1>Developer URL fixture</h1><p>${escapeHtml(address)}</p><p>本地合成页面；没有访问该地址。</p></main>`)}"></iframe>`;
  if (/\.md$/i.test(path)) {
    const html = escapeHtml(value).replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\n/g, "<br>");
    return `<article class="tt-preview-markdown">${html}</article>`;
  }
  return `<iframe class="tt-preview-frame" title="保存的 HTML 演示预览" sandbox="" srcdoc="${escapeHtml(value)}"></iframe>`;
}

function openDeveloperAddress(descriptor) {
  const root = api.openDialog("开发服务地址", "输入 http 或 https 地址。此原型只校验格式并展示本地页面，不会发起请求。",
    `<form id="editor-address-form"><label>预览地址<input id="editor-address" required value="${escapeHtml(descriptor.record.previewUrl || "http://localhost:3000/")}"></label><p role="alert" data-editor-address-error></p></form>`,
    '<button class="btn" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit" form="editor-address-form">确认预览</button>');
  root.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    let address;
    try { address = new URL(root.querySelector('#editor-address').value); } catch { /* Report below. */ }
    if (!address || !['http:', 'https:'].includes(address.protocol)) {
      root.querySelector('[data-editor-address-error]').textContent = '请输入有效的 http 或 https 地址。';
      return;
    }
    descriptor.record.previewUrl = address.href;
    descriptor.record.preview = true;
    api.save(); api.closeDialog(false); api.render();
  });
}

function mountFileTree({ app, route }) {
  const block = app.querySelector('.inspector .ins-block');
  const item = api.sessionById(route.sessionId);
  if (!block || !item) return;
  state.foldersByTree ||= {};
  const expanded = state.foldersByTree[item.tree] ||= {};
  const root = { children: new Map() };
  for (const path of availablePaths(item)) {
    let branch = root;
    const parts = path.split('/');
    parts.forEach((name, index) => {
      if (!branch.children.has(name)) branch.children.set(name, { name, path: parts.slice(0, index + 1).join('/'), children: new Map(), file: index === parts.length - 1 });
      branch = branch.children.get(name);
    });
  }
  const treeHtml = (branch) => [...branch.children.values()].map((child) => child.file
    ? `<button type="button" class="file-link tt-tree-file" data-action="editor-file" data-editor-path="${escapeHtml(child.path)}" title="${escapeHtml(child.path)}">${api.icon('file')}${escapeHtml(child.name)}</button>`
    : `<details data-editor-folder="${escapeHtml(child.path)}" ${expanded[child.path] ? 'open' : ''}><summary>${api.icon('folder')}${escapeHtml(child.name)}</summary>${treeHtml(child)}</details>`).join('');
  block.querySelectorAll('.file-link').forEach((node) => node.remove());
  const container = document.createElement('div');
  container.className = 'tt-file-tree'; container.dataset.testid = 'editor-file-tree';
  container.innerHTML = treeHtml(root); block.append(container);
  container.querySelectorAll('details').forEach((folder) => folder.addEventListener('toggle', () => { expanded[folder.dataset.editorFolder] = folder.open; api.save(); }));
  block.querySelector('[data-ins-filter]')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    container.querySelectorAll('.file-link').forEach((node) => { node.hidden = !node.dataset.editorPath.toLowerCase().includes(query); });
    container.querySelectorAll('details').forEach((folder) => { folder.open = query ? true : Boolean(expanded[folder.dataset.editorFolder]); });
  });
}

function mountFileSlot(context) {
  const shell = context.app.querySelector("[data-tt-feature-mounted='editor']");
  if (!shell) return;
  const descriptor = fileDescriptor(context);
  if (!descriptor) return;
  if (!descriptor.binary && !descriptor.large && !descriptor.failed && !descriptor.record.preview)
    mountEditor(shell.querySelector(".tt-editor-host"), descriptor);
  const tabs = document.querySelector("[data-testid='editor-file-tabs']");
  if (tabs) {
    tabs.querySelectorAll("[data-editor-path]").forEach((tab) => {
      tab.addEventListener("dragstart", (event) => { draggedTabPath = tab.dataset.editorPath; event.dataTransfer?.setData("text/plain", draggedTabPath); });
      tab.addEventListener("dragend", () => { draggedTabPath = null; });
      tab.addEventListener("dragover", (event) => event.preventDefault());
      tab.addEventListener("drop", (event) => {
        event.preventDefault();
        const from = draggedTabPath || event.dataTransfer?.getData("text/plain"), to = tab.dataset.editorPath;
        const paths = tabsFor(descriptor.item);
        if (!from || !to || from === to || !paths.includes(from)) return;
        const targetIndex = paths.indexOf(to);
        paths.splice(paths.indexOf(from), 1);
        paths.splice(targetIndex, 0, from);
        api.save();
        api.render();
        draggedTabPath = null;
      });
    });
  }
}

function fileSlot(context) {
  const descriptor = fileDescriptor(context);
  if (!descriptor) return null;
  const previewable = /\.(md|mdx|markdown|html?|svg)$/i.test(descriptor.path);
  const tabs = tabsFor(descriptor.item).map((path) => `<button type="button" draggable="true" class="tt-editor-tab${path === descriptor.path ? " active" : ""}" data-action="editor-file" data-editor-path="${escapeHtml(path)}">${escapeHtml(path.split("/").at(-1))}${state.documents[tabKey(descriptor.item, path)]?.dirty ? " ·" : ""}</button>`).join("");
  const conflict = descriptor.record.external ? `<div class="tt-editor-conflict" data-testid="editor-conflict">文件已在外部更改（模拟）。<button type="button" data-action="editor-conflict-keep" data-editor-key="${escapeHtml(descriptor.key)}">保留并覆盖</button><button type="button" data-action="editor-conflict-reload" data-editor-key="${escapeHtml(descriptor.key)}">重新载入</button></div>` : "";
  const controls = `<div class="tt-editor-tabs" data-testid="editor-file-tabs">${tabs}</div><div class="file-bar"><span class="path">${escapeHtml(descriptor.path)}</span><span class="dim">本地演示草稿 · CodeMirror</span><span class="grow"></span>${previewable ? `<button type="button" class="btn" data-action="editor-preview" data-editor-key="${escapeHtml(descriptor.key)}">${descriptor.record.preview ? "编辑" : "预览"}</button>` : ""}<button type="button" class="btn" data-action="editor-save" data-editor-key="${escapeHtml(descriptor.key)}">保存草稿</button><button type="button" class="btn" data-action="editor-close" data-editor-key="${escapeHtml(descriptor.key)}">关闭当前</button><button type="button" class="btn" data-action="editor-close-others">关闭其他</button><button type="button" class="icon-btn" aria-label="关闭全部文件" data-action="editor-close-all">×</button></div>${conflict}`;
  let body = `<div class="tt-editor-meta"><span data-testid="editor-dirty"${descriptor.record.dirty ? "" : " hidden"}>未保存</span>${descriptor.record.readOnly ? "<span>只读</span>" : ""}<span>${escapeHtml(descriptor.path)}</span></div><div class="tt-editor-host"></div>`;
  if (descriptor.binary) body = '<div class="tt-editor-state"><b>二进制文件</b><p>该演示文件无法作为文本打开。</p></div>';
  else if (descriptor.large) body = '<div class="tt-editor-state"><b>文件过大</b><p>此合成文件大小为 2 MB，超过当前 1 MB 编辑上限。保留摘要，不载入编辑器。</p></div>';
  else if (descriptor.failed) body = `<div class="tt-editor-state"><b>无法读取文件</b><p>模拟读取错误。请重试。</p><button type="button" class="btn" data-action="editor-retry-file" data-editor-key="${escapeHtml(descriptor.key)}">重试读取</button></div>`;
  else if (descriptor.record.preview) body = previewHtml(descriptor.path, /\.html?$/i.test(descriptor.path) ? descriptor.record.saved : descriptor.record.draft, descriptor.record.previewUrl);
  const fixtureState = descriptor.binary ? "binary" : descriptor.large ? "large" : descriptor.failed ? "failed" : descriptor.record.readOnly ? "readonly" : "editable";
  return `${controls}<section class="tt-editor-shell" data-tt-feature-mounted="editor" data-testid="codemirror-editor" data-editor-state="${fixtureState}" data-editor-key="${escapeHtml(descriptor.key)}">${body}</section>`;
}

function diffSlot(context) {
  const descriptor = fileDescriptor(context);
  if (!descriptor) return null;
  const kind = descriptor.record.stage || (context.fileIndex === 1 ? "未跟踪" : context.fileIndex === 2 ? "已暂存" : "未暂存");
  const editable = kind !== "已暂存";
  const actions = editable
    ? `<button type="button" class="btn" data-action="editor-diff-stage" data-editor-key="${escapeHtml(descriptor.key)}">暂存</button><button type="button" class="btn" data-action="editor-diff-revert-line" data-editor-key="${escapeHtml(descriptor.key)}">还原当前行</button><button type="button" class="btn" data-action="editor-diff-revert-hunk" data-editor-key="${escapeHtml(descriptor.key)}">还原当前块</button><button type="button" class="btn" data-action="editor-save" data-editor-key="${escapeHtml(descriptor.key)}">保存变更</button>`
    : `<button type="button" class="btn" data-action="editor-diff-stage" data-editor-key="${escapeHtml(descriptor.key)}">取消暂存</button>`;
  return `<section class="tt-diff-shell" data-tt-feature-mounted="diff" data-editor-key="${escapeHtml(descriptor.key)}"><div class="file-bar"><span class="path">${escapeHtml(descriptor.path)}</span><span class="dim" data-testid="editor-diff-state">${kind} · ${editable ? "左侧基线只读，右侧可编辑" : "两侧只读"}</span><span class="grow"></span>${actions}</div><div class="tt-diff-host"></div></section>`;
}

function mountDiffSlot(context) {
  const host = context.app.querySelector("[data-tt-feature-mounted='diff'] .tt-diff-host");
  if (!host) return;
  const descriptor = fileDescriptor(context);
  if (!descriptor) return;
  destroyMergeView(descriptor.key);
  const record = descriptor.record;
  const base = record.base || record.saved;
  const editable = (record.stage || (context.fileIndex === 2 ? "已暂存" : "")) !== "已暂存";
  const merge = new MergeView({
    a: { doc: base, extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), ...extensions({ path: descriptor.path, value: base }, () => {}, () => {}, true)] },
    b: { doc: record.draft, extensions: extensions({ path: descriptor.path, value: record.draft }, (value) => { record.draft = value; record.dirty = value !== record.saved; api.save(); }, () => saveDocument(descriptor), !editable) },
    parent: host,
    ...(editable ? { revertControls: "a-to-b", renderRevertControl: () => { const button = document.createElement("button"); button.type = "button"; button.textContent = "还原"; button.className = "tt-diff-revert"; return button; } } : {}),
    highlightChanges: true,
  });
  mergeViews.set(descriptor.key, { view: merge, descriptor, editable });
}

function syncDiffDraft(mounted) {
  const record = mounted.descriptor.record;
  record.draft = mounted.view.b.state.doc.toString();
  record.dirty = record.draft !== record.saved;
  api.save();
}

function revertCurrentDiffLine(mounted) {
  const current = mounted.view.b;
  const base = mounted.view.a;
  const line = current.state.doc.lineAt(current.state.selection.main.head);
  if (line.number > base.state.doc.lines) return false;
  const replacement = base.state.doc.line(line.number).text;
  if (line.text === replacement) return false;
  current.dispatch({ changes: { from: line.from, to: line.to, insert: replacement } });
  syncDiffDraft(mounted);
  return true;
}

function revertCurrentDiffHunk(mounted) {
  const current = mounted.view.b;
  const base = mounted.view.a;
  const chunks = getChunks(current.state)?.chunks;
  const head = current.state.selection.main.head;
  const chunk = chunks?.find((candidate) => candidate.fromB <= head && head <= candidate.toB);
  if (!chunk) return false;
  let replacement = base.state.sliceDoc(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1));
  if (chunk.fromA !== chunk.toA && chunk.toB <= current.state.doc.length) replacement += current.state.lineBreak;
  current.dispatch({ changes: { from: chunk.fromB, to: Math.min(current.state.doc.length, chunk.toB), insert: replacement }, userEvent: "revert" });
  syncDiffDraft(mounted);
  return true;
}

function closeDocument(key) {
  const item = api.sessionById(api.ui.route.sessionId);
  if (!item) return;
  const path = key.startsWith(`${item.tree}:`) ? key.slice(item.tree.length + 1) : state.selectedPaths[item.tree];
  requestTabClose(item, [path]);
}

function register() {
  api = window.ThreadTermPrototype;
  if (!api || !api.featureState) return;
  state = api.featureState("editor", { documents: {}, scenarios: {} });
  state.documents ||= {};
  state.selectedPaths ||= {};
  state.tabsByTree ||= {};
  api.onBeforeRender(() => {
    focusedEditorKey = null;
    views.forEach((mounted, key) => {
      if (mounted.view.hasFocus) focusedEditorKey = key;
      destroyView(key);
    });
    mergeViews.forEach((_, key) => destroyMergeView(key));
  });
  api.onReset?.(() => {
    views.forEach((_, key) => destroyView(key));
    mergeViews.forEach((_, key) => destroyMergeView(key));
    cachedStates.clear();
    focusedEditorKey = null;
  });
  api.registerContentSlot("file", fileSlot);
  api.registerContentSlot("diff", diffSlot);
  api.onRender(mountFileSlot);
  api.onRender(mountDiffSlot);
  api.onRender(mountFileTree);
  api.registerActions({
    "editor-preview": (el) => { const record = state.documents[el.dataset.editorKey]; if (!record) return; const descriptor = fileDescriptor({ ui: api.ui }); if (descriptor?.path.includes("developer-address") && !record.preview) return openDeveloperAddress(descriptor); record.preview = !record.preview; api.save(); api.render(); },
    "editor-save": (el) => { const mounted = views.get(el.dataset.editorKey) || mergeViews.get(el.dataset.editorKey); const descriptor = mounted?.descriptor || fileDescriptor({ ui: api.ui }); if (descriptor) { saveDocument(descriptor); if (!mounted) api.render(); } },
    "editor-close": (el) => closeDocument(el.dataset.editorKey),
    "editor-file": (el) => { refreshState(); const item = api.sessionById(api.ui.route.sessionId); if (!item) return; const tabs = tabsFor(item); if (!tabs.includes(el.dataset.editorPath)) tabs.push(el.dataset.editorPath); state.selectedPaths[item.tree] = el.dataset.editorPath; api.ui.wsTab = "file"; const index = api.projects[item.project].files.indexOf(el.dataset.editorPath); if (index >= 0) api.ui.wsFile = index; api.save(); api.render(); },
    "editor-close-others": () => { const item = api.sessionById(api.ui.route.sessionId); if (!item) return; requestTabClose(item, tabsFor(item).filter((path) => path !== state.selectedPaths[item.tree])); },
    "editor-close-all": () => { const item = api.sessionById(api.ui.route.sessionId); if (!item) return; requestTabClose(item, [...tabsFor(item)]); },
    "editor-retry-file": (el) => { const record = state.documents[el.dataset.editorKey]; if (record) record.retried = true; api.save(); api.render(); },
    "editor-diff-revert-line": (el) => { const mounted = mergeViews.get(el.dataset.editorKey); if (mounted?.editable && revertCurrentDiffLine(mounted)) api.toast("已还原当前行。"); },
    "editor-diff-revert-hunk": (el) => { const mounted = mergeViews.get(el.dataset.editorKey); if (mounted?.editable && revertCurrentDiffHunk(mounted)) api.toast("已还原当前差异块。"); },
    "editor-diff-stage": (el) => { const record = state.documents[el.dataset.editorKey]; if (!record) return; record.stage = record.stage === "已暂存" ? "未暂存" : "已暂存"; api.save(); api.render(); },
    "editor-conflict-keep": (el) => { const record = state.documents[el.dataset.editorKey]; if (record) { record.external = false; record.saveError = false; } api.save(); api.render(); api.toast("已选择保留本地草稿并覆盖模拟外部版本。"); },
    "editor-conflict-reload": (el) => { const record = state.documents[el.dataset.editorKey]; if (record) { record.draft = record.saved; record.dirty = false; record.external = false; forgetView(el.dataset.editorKey); } api.save(); api.render(); api.toast("已重新载入模拟保存版本。"); },
    "editor-discard": () => { const pending = state.pendingTabClose, item = pending && api.sessionById(api.ui.route.sessionId); if (pending && item?.tree === pending.tree) { api.closeDialog(false); closeTabPaths(item, pending.paths, "discard"); } },
    "editor-save-close": () => { const pending = state.pendingTabClose, item = pending && api.sessionById(api.ui.route.sessionId); if (pending && item?.tree === pending.tree) { if (!closeTabPaths(item, pending.paths, "save")) return api.toast("只读、冲突或失败草稿不能保存关闭；请放弃或先解决问题。"); api.closeDialog(false); } },
    "editor-scene": (el) => { const key = el.dataset.editorKey; const record = state.documents[key]; if (!record) return; if (el.dataset.scene === "save-error") record.saveError = true; if (el.dataset.scene === "external") record.external = true; api.save(); api.render(); },
    "editor-scenario": (el) => { refreshState(); state.scenario = el.dataset.scene || ""; const session = el.dataset.scene === "markdown" ? "docs-gemini" : "orbit-claude"; if (el.dataset.scene === "save-error") state.nextSaveError = true; if (el.dataset.scene === "external") state.nextExternal = true; api.save(); api.openSession(session); api.ui.wsTab = "file"; api.render(); },
  });
  api.extendMenu("scenario", () => '<div class="menu-sep"></div><div class="menu-label">文件编辑演示</div><button type="button" class="menu-item" data-action="editor-scenario" data-scene="">日常编辑<span class="dim">CodeMirror、保存、预览和差异</span></button><button type="button" class="menu-item" data-action="editor-scenario" data-scene="markdown">Markdown 预览<span class="dim">保存的本地文档</span></button><button type="button" class="menu-item" data-action="editor-scenario" data-scene="external">外部更改冲突<span class="dim">重新载入或覆盖</span></button><button type="button" class="menu-item" data-action="editor-scenario" data-scene="save-error">模拟保存失败<span class="dim">可重试</span></button><button type="button" class="menu-item" data-action="editor-scenario" data-scene="readonly">只读文件<span class="dim">不能保存</span></button><button type="button" class="menu-item" data-action="editor-scenario" data-scene="binary">二进制文件<span class="dim">不能作为文本打开</span></button><button type="button" class="menu-item" data-action="editor-scenario" data-scene="large">大文件<span class="dim">摘要而非高亮</span></button><button type="button" class="menu-item" data-action="editor-scenario" data-scene="read-failure">读取失败<span class="dim">可重试演示</span></button>');
  api.render();
}

if (window.ThreadTermPrototype) register();
else window.addEventListener("threadtermprototype", register, { once: true });
