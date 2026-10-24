// Renderer-level F11 measurement for long active sessions.
//
// It mounts the production ChatView on one 1,000-record transcript twice: once from the working tree ("current") and
// once from a bundle whose ChatView and chatPresentation modules are replaced by their HEAD text (the pre-F11
// whole-history scan and always-mounted folded bodies). Both mounts send the same mocked `chat.snapshot`, so the only
// difference is the presentation work. Pure renderer: no runtime, no provider, no network.
//
//   node qa/chat-long-transcript-visual.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const TURNS = 200;
const scratch = await mkdtemp(join(tmpdir(), "threadterm-chat-long-"));
const out = resolve("qa", "results", "chat-long-transcript", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(out, { recursive: true });

// HEAD text for the two modules this job changed; a pinned pre-F11 revision keeps the comparison reproducible after
// this work is committed. `onLoad` keeps the module's own resolveDir, so the legacy copy still resolves its imports
// (React, tool cards, CSS) from the renderer tree instead of a copied folder.
const BASELINE = "652b817"; // last commit before the F11 presentation work
const headSources = Object.fromEntries(
  ["renderer/src/components/ChatView.tsx", "renderer/src/chatPresentation.ts"].map(path => [path, execFileSync("git", ["show", `${BASELINE}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })]),
);
const headModules = {
  name: "head-presentation",
  setup(builder) {
    builder.onLoad({ filter: /components[\\/]ChatView\.tsx$/ }, args => ({ contents: headSources["renderer/src/components/ChatView.tsx"], loader: "tsx", resolveDir: dirname(args.path) }));
    builder.onLoad({ filter: /[\\/]chatPresentation\.ts$/ }, args => ({ contents: headSources["renderer/src/chatPresentation.ts"], loader: "ts", resolveDir: dirname(args.path) }));
  },
};

const fixture = `
const text = (body, status = 'complete') => ({ type: 'text', text: body, status });
const turns = ${TURNS};
const items = [];
for (let turn = 0; turn < turns; turn += 1) {
  const turnId = 'turn-' + turn, first = items.length;
  items.push({ id: turnId + '-user', role: 'user', turnId, createdAt: String(first), parts: [text('Prompt ' + turn)] });
  items.push({ id: turnId + '-thinking', role: 'assistant', turnId, createdAt: String(first + 1), parts: [{ type: 'thinking', text: 'Working through request ' + turn, status: 'complete' }] });
  items.push({ id: turnId + '-tool', role: 'assistant', turnId, createdAt: String(first + 2), parts: [{ type: 'tool', toolName: 'Read', toolId: 'tool-' + turn, status: 'complete', text: 'AGENTS.md' }] });
  items.push({ id: turnId + '-answer', role: 'assistant', turnId, createdAt: String(first + 3), elapsedMs: 6000, parts: [text('Answer ' + turn)] });
  items.push({ id: turnId + '-done', role: 'assistant', turnId, createdAt: String(first + 4), turnStatus: 'completed', elapsedMs: 6000, parts: [] });
}
items.push({ id: 'live-user', role: 'user', turnId: 'turn-live', createdAt: 'live', parts: [text('A long session, now streaming')] });
items.push({ id: 'live-answer', role: 'assistant', turnId: 'turn-live', createdAt: 'live', parts: [text('Streaming answer', 'streaming')] });
`;
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './renderer/src/components/ChatView';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';
${fixture}
const session = { id: 'long-transcript-__QA_VARIANT__', provider: 'codex', mode: 'chat', status: 'running', readOnly: true, title: 'Long QA', createdAt: 'now', updatedAt: 'now' };
window.threadterm = {
  onEvent: () => () => {},
  async request(method, params) {
    if (method === 'chat.snapshot') return { items, revision: 1 };
    if (method === 'chat.draft.read') return { text: '', revision: 0 };
    if (method === 'chat.queue.read') return { sessionId: params.sessionId, paused: false, items: [] };
    if (method === 'chat.feedback.read') return { notes: [] };
    if (method === 'chat.options') return { options: [], commands: [] };
    throw new Error('Unexpected QA request ' + method);
  },
};
const expected = new Set(items.map(item => item.turnId)).size;
window.qa = window.qa || {};
window.qa[__QA_VARIANT__] = {
  async mount() {
    if (window.qaActive) { window.qaActive(); window.qaActive = undefined; }
    const host = document.getElementById('root');
    host.replaceChildren();
    const node = document.createElement('div');
    host.append(node);
    const root = createRoot(node);
    window.qaActive = () => root.unmount();
    const started = performance.now();
    root.render(<I18nProvider locale="zh-CN"><ChatView session={session} /></I18nProvider>);
    while (document.querySelectorAll('.chat-turn').length < expected) {
      if (performance.now() - started > 180000) break;
      await new Promise(done => setTimeout(done, 10));
    }
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return {
      ms: performance.now() - started,
      records: items.length,
      turns: document.querySelectorAll('.chat-turn').length,
      elements: document.querySelectorAll('#root *').length,
      foldedBodies: document.querySelectorAll('.codex-work-body').length,
    };
  },
  geometry() {
    const base = document.getElementById('root').getBoundingClientRect();
    const relative = element => { const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left - base.left), y: Math.round(rect.top - base.top), w: Math.round(rect.width), h: Math.round(rect.height) }; };
    const sections = [...document.querySelectorAll('.chat-turn')].filter(section => section.querySelector('.codex-work > summary'));
    const first = sections[0], last = sections.at(-1);
    const log = document.querySelector('.v3-chat-log');
    return {
      firstUser: relative(document.querySelector('article.user')),
      firstDuration: relative(first.querySelector('.codex-work > summary')),
      lastDuration: relative(last.querySelector('.codex-work > summary')),
      lastAnswer: relative([...last.querySelectorAll('article')].at(-1)),
      scrolledToBottom: Math.abs(log.scrollHeight - log.clientHeight - log.scrollTop) < 4,
    };
  },
};
`;
for (const [variant, plugins] of [["current", []], ["legacy", [headModules]]]) {
  await build({
    stdin: { contents: entry, resolveDir: resolve("."), loader: "tsx" },
    plugins,
    define: { __QA_VARIANT__: JSON.stringify(variant) },
    bundle: true,
    outfile: join(scratch, `qa-${variant}.js`),
    jsx: "automatic",
    logLevel: "error",
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
  });
}
await writeFile(join(scratch, "index.html"), '<meta charset="utf-8"><link rel="stylesheet" href="qa-current.css"><style>html,body{height:100%;margin:0}#root{height:100vh;display:flex}#root>div{min-width:0;min-height:0;flex:1;display:flex}</style><div id="root"></div><script src="qa-current.js"></script><script src="qa-legacy.js"></script>');
await writeFile(join(scratch, "main.cjs"), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, "profile"))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch, "index.html"))}));`);

let app;
try {
  app = await electron.launch({ args: [join(scratch, "main.cjs")] });
  const page = await app.firstWindow();
  page.setDefaultTimeout(240_000);
  await page.waitForFunction(() => Boolean(window.qa?.current && window.qa?.legacy));
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  const measure = async variant => ({ ...await page.evaluate(name => window.qa[name].mount(), variant), geometry: await page.evaluate(name => window.qa[name].geometry(), variant) });
  // Alternate the order: the first mount in a page pays React, stylesheet and font warm-up for both variants.
  const runs = { current: [], legacy: [] };
  for (const variant of ['legacy', 'current', 'legacy', 'current']) runs[variant].push(await measure(variant));
  const median = variant => [...runs[variant].map(run => run.ms)].sort((left, right) => left - right)[Math.floor(runs[variant].length / 2)];
  const current = { ...runs.current[0], ms: median('current'), runs: runs.current.map(run => Math.round(run.ms)) };
  const legacy = { ...runs.legacy[0], ms: median('legacy'), runs: runs.legacy.map(run => Math.round(run.ms)) };
  await measure('current');
  await page.screenshot({ path: join(out, 'current-collapsed.png') });
  await measure('legacy');
  await page.screenshot({ path: join(out, 'legacy-collapsed.png') });
  assert.equal(current.turns, legacy.turns, 'both variants group the same turns');
  assert.deepEqual(current.geometry, legacy.geometry, 'collapsed presentation layout is identical');
  assert.equal(current.foldedBodies, 0, 'collapsed folded bodies are not mounted');
  assert.equal(legacy.foldedBodies, TURNS, 'the pre-F11 build kept every collapsed body mounted');
  assert.ok(current.elements < legacy.elements, `lazy folded bodies keep the DOM smaller (${current.elements} vs ${legacy.elements} elements)`);
  await writeFile(join(out, "report.json"), `${JSON.stringify({ passed: true, current, legacy, scratch }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, out, current, legacy }));
} finally {
  await app?.close();
}
