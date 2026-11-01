// Visual QA for agent tiles: sidebar rows, tabs, pane header, size ladder, and a
 // shell→agent switch. Hidden Electron; no runtime, no agent CLIs.
 // Screenshots → qa/results/agent-tiles/<label>/
 //   node qa/agent-tiles-visual.mjs [label]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const label = process.argv[2] || 'current';
const out = join(root, 'qa/results/agent-tiles', label);
const scratch = await mkdtemp(join(tmpdir(), 'tt-agent-tiles-'));

const entry = String.raw`
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentTile, SessionIcon, AgentIcon, AgentIconsProvider } from './renderer/src/components/PrototypeIcon';
import './renderer/src/styles.css';

const now = '2026-11-01T12:00:00Z';
const session = (id, provider, title, extra = {}) => ({
  id, title, provider, mode: provider === 'shell' || provider === 'custom' ? 'terminal' : 'chat',
  status: 'running', createdAt: now, updatedAt: now, projectId: 'p', ...extra,
});
const rows = [
  session('c1', 'claude', 'Fix delegate outcome'),
  session('x1', 'codex', 'Review Run palette'),
  session('s1', 'shell', 'PowerShell', { terminalAgent: 'claude' }),
  session('r1', 'custom', 'npm run dev'),
];
const sizes = [14, 16, 20, 28, 64];
const brands = ['claude', 'codex', 'gemini', 'kimi', 'grok', 'opencode', 'shell'];

function Gallery({ theme }) {
  const [shell, setShell] = useState(session('live', 'shell', 'PowerShell'));
  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.qaSetShell = (agent) => setShell(session('live', 'shell', 'PowerShell', agent ? { terminalAgent: agent } : {}));
  }, [theme]);
  return (
    <div className="theme" data-theme={theme} style={{ padding: 20, background: 'var(--bg)', color: 'var(--text)', font: '13px/1.4 Segoe UI, sans-serif' }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>{theme === 'light' ? 'Light' : 'Dark'} tiles</h2>
      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: '1fr 1fr' }}>
        <section style={{ gridColumn: '1 / -1', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>Every agent, size ladder</h3>
          {sizes.map(size => (
            <div key={size} data-testid={'sizes-' + size} style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '8px 0' }}>
              {brands.map(id => <AgentTile key={id + size} provider={id} size={size} />)}
            </div>
          ))}
        </section>
        <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>Sidebar rows</h3>
          <div style={{ background: 'var(--side)', borderRadius: 8, padding: 8, width: 250 }}>
            {rows.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 8px', borderRadius: 6 }}>
                <SessionIcon session={s} size={16} />
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span>{s.title}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>{s.mode === 'chat' ? 'Chat' : 'Terminal'}{s.terminalAgent ? ' · ' + s.terminalAgent : ''}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
        <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>Shell detects an agent</h3>
          <div data-testid="shell-switch" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 8px', background: 'var(--side)', borderRadius: 6, width: 220 }}>
            <SessionIcon session={shell} size={16} />
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span>{shell.title}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Terminal{shell.terminalAgent ? ' · ' + shell.terminalAgent : ''}</span>
            </span>
          </div>
        </section>
        <section style={{ gridColumn: '1 / -1', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>Tab bar and pane header</h3>
          <div data-testid="tabs" style={{ display: 'flex', gap: 2, background: 'var(--side)', padding: 4, borderRadius: 8 }}>
            {rows.map((s, index) => (
              <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 6, background: index === 1 ? 'var(--surface)' : 'transparent', color: index === 1 ? 'var(--text)' : 'var(--muted)' }}>
                <SessionIcon session={s} size={16} />{s.title}
              </span>
            ))}
          </div>
          <div data-testid="pane-head" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
            <SessionIcon session={rows[1]} size={16} />
            <strong>{rows[1].title}</strong>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>{rows[1].provider} · D:/project/ThreadTerm</span>
          </div>
        </section>
        <section style={{ gridColumn: '1 / -1', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>Inline mentions stay flat</h3>
          <p data-testid="inline-flat">Delegated by <a href="#"><AgentIcon provider="claude" size={16} /> Fix delegate outcome</a> · handed to <a href="#"><AgentIcon provider="codex" size={16} /> Codex</a></p>
        </section>
      </div>
    </div>
  );
}

window.threadterm = { onEvent: () => () => {}, request: async () => { throw Error('unexpected'); } };
const root = createRoot(document.getElementById('root'));
window.qaRender = (theme) => root.render(<AgentIconsProvider providers={[]}><Gallery theme={theme} /></AgentIconsProvider>);
window.qaRender('light');
`;

await mkdir(out, { recursive: true });
await build({
  stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
  bundle: true,
  outfile: join(scratch, 'qa.js'),
  jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  alias: { '@threadterm/protocol': join(root, 'protocol/index.ts') },
  logLevel: 'error',
});
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{margin:0;background:#888}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:1400,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app;
let page;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], timeout: 60_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('[data-testid="shell-switch"]').waitFor();

  for (const theme of ['light', 'dark']) {
    await page.evaluate(next => window.qaRender(next), theme);
    await page.evaluate(() => window.qaSetShell?.(null));
    await page.waitForTimeout(50);
    // Before → after detection → clear.
    await page.screenshot({ path: join(out, `${theme}-1x-shell.png`), animations: 'disabled' });
    await page.evaluate(() => window.qaSetShell?.('claude'));
    await page.waitForTimeout(50);
    const tile = page.locator('[data-testid="shell-switch"] [data-agent-tile]');
    assert.equal(await tile.getAttribute('data-agent-tile'), 'claude', `${theme}: shell did not switch to claude tile`);
    await page.screenshot({ path: join(out, `${theme}-1x.png`), animations: 'disabled' });
    report.screenshots.push(join(out, `${theme}-1x.png`));

    // Full-page capture already includes the ladder; also crop the 16px row.
    const ladderBox = await page.locator('[data-testid="sizes-16"]').boundingBox();
    assert.ok(ladderBox && ladderBox.height > 0, `${theme}: size ladder missing`);
    await page.screenshot({
      path: join(out, `${theme}-sizes.png`),
      animations: 'disabled',
      clip: {
        x: Math.max(0, ladderBox.x - 8),
        y: Math.max(0, ladderBox.y - 8),
        width: ladderBox.width + 16,
        height: ladderBox.height + 16,
      },
    });
    report.screenshots.push(join(out, `${theme}-sizes.png`));

    // Flat inline marks must not be tiles.
    const inlineTiles = await page.locator('[data-testid="inline-flat"] .agent-tile').count();
    assert.equal(inlineTiles, 0, `${theme}: inline mentions must stay flat`);
    const flat = await page.locator('[data-testid="inline-flat"] .brand-ico').count();
    assert.ok(flat >= 2, `${theme}: expected flat brand marks inline`);
    report.checks.push(`${theme}: sidebar/tabs/header/size ladder rendered; shell switch and flat inline ok`);
  }
  report.passed = true;
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.errors.push(String(error?.stack || error));
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
}
