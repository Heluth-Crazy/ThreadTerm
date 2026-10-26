// Isolated mounted-production surfaces for panel consistency visual QA.
// The harness supplies this file as an esbuild entry; it deliberately has no runtime or provider process.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider, type Locale } from '../../renderer/src/i18n';
import { applyThemeTokens } from '../../renderer/src/themes';
import { BlockInspector } from '../../renderer/src/components/BlockInspector';
import { WorktreeManager } from '../../renderer/src/components/WorktreeManager';
import { TaskMapView } from '../../renderer/src/components/TaskMapView';
import { GitHistoryView } from '../../renderer/src/components/GitHistoryView';
import { ReviewDiffView } from '../../renderer/src/components/ReviewDiffView';
import { DelegationPanel } from '../../renderer/src/components/DelegationPanel';
import { TerminalSurface } from '../../renderer/src/components/TerminalSurface';
import { SessionHistoryRail } from '../../renderer/src/components/SessionHistoryRail';
import { taskMapFixture } from '../../renderer/src/fixtures/taskMapFixtures';
import './../../renderer/src/styles.css';
import './../../renderer/src/components/file-workspace.css';
import './../../renderer/src/components/workspace-parity.css';
import './../../renderer/src/components/panel-headers.css';

type Surface = 'block-inspector' | 'worktree-manager' | 'task-map' | 'git-history' | 'review-diff' | 'delegation' | 'terminal' | 'local-history';

declare global {
  interface Window {
    qaPanelSurfaces: {
      render: (surface: Surface, locale?: Locale, theme?: 'light' | 'dark') => void;
    };
  }
}

const project = { id: 'qa-project', name: 'Panel consistency fixture', path: 'D:/panel-fixture', createdAt: '2026-10-22T12:00:00.000Z' };
const rootSession = { id: 'qa-root', projectId: project.id, worktreePath: project.path, title: 'Inspect panel headers', provider: 'codex', mode: 'chat' as const, status: 'idle' as const, createdAt: project.createdAt, updatedAt: project.createdAt };
const terminalSession = { id: 'qa-terminal', projectId: project.id, worktreePath: project.path, title: 'Panel header terminal', provider: 'codex', mode: 'terminal' as const, status: 'exited' as const, readOnly: true, cols: 100, rows: 30, createdAt: project.createdAt, updatedAt: project.createdAt };
const delegates = [
  { ...rootSession, id: 'qa-delegate-running', title: 'Check inspector treatment', provider: 'claude', delegation: { id: 'qa-delegation-running', parentSessionId: rootSession.id, workspace: 'worktree' as const, branch: 'qa/header-audit', state: 'running' as const, userMessages: 2 } },
  { ...rootSession, id: 'qa-delegate-done', title: 'Review dialog headers', provider: 'kimi', delegation: { id: 'qa-delegation-done', parentSessionId: rootSession.id, workspace: 'shared' as const, state: 'completed' as const } },
];
const commits = [
  { hash: 'b1c2d3e4f5a6', parents: ['a1b2c3d4e5f6'], refs: ['HEAD -> main'], subject: 'Align panel headers', authorName: 'QA Author', authorEmail: 'qa@example.invalid', authoredAt: '2026-10-22T12:00:00.000Z' },
  { hash: 'a1b2c3d4e5f6', parents: [], refs: ['origin/main'], subject: 'Add panel fixture data', authorName: 'QA Author', authorEmail: 'qa@example.invalid', authoredAt: '2026-10-21T12:00:00.000Z' },
];
const review = { exists: true, binary: false, fingerprint: 'qa-review-fingerprint', oldText: 'export const panel = "before";\n', newText: 'export const panel = "after";\n' };
const providers = [{ id: 'codex', name: 'Codex', installed: true, terminal: true, chat: true, history: true, resume: false, auth: 'authenticated' }];
const nativeHistory = [{ provider: 'codex', nativeId: 'qa-native-header-audit', title: 'Native panel header audit', cwd: project.path, updatedAt: project.createdAt, resumable: false }];
const historySnapshot = {
  epoch: 'qa', revision: 1, projects: [project], sessions: [rootSession, terminalSession, ...delegates], settings: { revision: 1 }, workspaces: [], inbox: [], providers,
} as unknown as import('@threadterm/protocol').Snapshot;

const clone = <T,>(value: T): T => structuredClone(value);
const mapFixture = () => taskMapFixture('delegation');

// Components use the normal bridge module. This deterministic page-local bridge supports only their initial loads.
(window as unknown as { threadterm: unknown }).threadterm = {
  request: async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'runtime.snapshot') return clone(historySnapshot);
    if (method === 'provider.list') return clone(providers);
    if (method === 'worktree.list') return clone([
      { id: 'qa-main', projectId: project.id, path: project.path, branch: 'main', head: 'b1c2d3e4', isMain: true, locked: false, missing: false },
      { id: 'qa-feature', projectId: project.id, path: 'D:/panel-fixture-header-audit', branch: 'qa/header-audit', head: 'a1b2c3d4', isMain: false, locked: false, missing: false },
    ]);
    if (method === 'worktree.branches') return clone([
      { name: 'main', current: true, lastCommit: { id: commits[0].hash, subject: commits[0].subject, committedAt: commits[0].authoredAt } },
      { name: 'qa/header-audit', current: false, lastCommit: { id: commits[1].hash, subject: commits[1].subject, committedAt: commits[1].authoredAt } },
    ]);
    if (method === 'chat.snapshot') {
      const fixture = mapFixture();
      return { items: clone(fixture.items.get(String(params.sessionId)) ?? []), revision: 1, hasEarlier: false, repair: { offered: false } };
    }
    if (method === 'session.documents.list') return clone(mapFixture().documents);
    if (method === 'review.changes') return { files: [{ path: 'renderer/src/components/BlockInspector.tsx', added: 4, removed: 1, status: 'M' }] };
    if (method === 'chat.subagent.read') return { items: [], rev: 1, source: 'native', truncated: false };
    if (method === 'chat.read') return [{ id: 'qa-result', role: 'assistant', createdAt: project.createdAt, parts: [{ type: 'text', text: 'Fixture delegation result.' }] }];
    if (method === 'git.log') return { commits: clone(commits), hasMore: false, scope: 'current' };
    if (method === 'git.branches') return { branches: [{ name: 'main', remote: false }, { name: 'origin/main', remote: true }] };
    if (method === 'git.commit.show') return { commit: clone(commits.find(commit => commit.hash === params.commit) ?? commits[0]), body: 'Fixture commit used to render the panel header.', files: [{ path: 'renderer/src/components/BlockInspector.tsx', status: 'M' }] };
    if (method === 'git.commit.diff') return { path: String(params.path), oldText: review.oldText, newText: review.newText, binary: false };
    if (method === 'review.diff') return clone(review);
    if (method === 'history.list') return { items: clone(nativeHistory) };
    if (method === 'history.read') return [
      { id: 'qa-history-user', role: 'user', createdAt: project.createdAt, parts: [{ type: 'text', text: 'Inspect the panel header treatment.' }] },
      { id: 'qa-history-assistant', role: 'assistant', createdAt: project.createdAt, parts: [{ type: 'text', text: 'The fixture exposes this saved native transcript.' }] },
    ];
    if (method === 'terminal.read') return { nextCursor: 0 };
    if (method === 'filesystem.write') return { path: params.path, content: params.content, readonly: false, fingerprint: review.fingerprint, size: String(params.content ?? '').length, modifiedAt: project.createdAt };
    if (method === 'session.stop' || method === 'review.revert') return {};
    throw new Error(`Unsupported panel fixture request: ${method}`);
  },
  onEvent: () => () => {},
  subscribeOutput: async () => () => {},
  onPageContextMenu: () => () => {},
  openExternal: async () => undefined,
  windowsPty: { backend: 'conpty', buildNumber: 22631 },
  platform: 'win32',
};

const root = createRoot(document.getElementById('root')!);
const copy = (en: string, zh: string) => document.documentElement.lang === 'zh-CN' ? zh : en;

function SurfaceView({ surface, locale }: { surface: Surface; locale: Locale }) {
  const zh = locale === 'zh-CN';
  if (surface === 'block-inspector') return <main className="qa-panel-surface terminal-surface"><BlockInspector sessionId={rootSession.id} text={'const selected = panel.header;\ninspect the current header treatment;'} onClose={() => undefined}/></main>;
  if (surface === 'worktree-manager') return <main className="qa-panel-surface"><WorktreeManager project={project} initialWorktreeId="qa-main" onClose={() => undefined} onChanged={() => undefined}/></main>;
  if (surface === 'task-map') {
    const fixture = mapFixture();
    return <main className="qa-panel-surface pane-tab-surface"><TaskMapView sessionId={fixture.rootSessionId} sessions={fixture.sessions} visible zh={zh} onClose={() => undefined} onOpenSession={() => undefined} onOpenFile={() => undefined} onOpenReview={() => undefined}/></main>;
  }
  if (surface === 'git-history') return <main className="qa-panel-surface pane-tab-surface"><GitHistoryView projectId={project.id} worktreePath={project.path} zh={zh}/></main>;
  if (surface === 'review-diff') return <main className="qa-panel-surface pane-tab-surface"><ReviewDiffView projectId={project.id} worktreePath={project.path} path="renderer/src/components/BlockInspector.tsx" sessionId={rootSession.id} checkpointId="qa-before" editorId="qa-review-diff" zh={zh}/></main>;
  if (surface === 'terminal') return <main className="qa-panel-surface"><TerminalSurface sessionId={terminalSession.id} session={terminalSession} provider="codex" theme={document.documentElement.dataset.theme==='dark'?'dark':'light'} terminalCompatibility={{}}/></main>;
  if (surface === 'local-history') return <main className="qa-panel-surface"><SessionHistoryRail data={historySnapshot} onClose={() => undefined} onNavigateAll={() => undefined} onChanged={() => undefined}/></main>;
  return <main className="qa-panel-surface"><DelegationPanel session={rootSession} delegates={delegates} onOpenSession={() => undefined} copy={copy} zh={zh}/></main>;
}

window.qaPanelSurfaces = {
  render(surface, locale = 'en', theme = 'light') {
    document.documentElement.lang = locale;
    document.documentElement.dataset.theme = theme;
    // The app paints theme roles as inline tokens; without them the fixture falls back to the
    // stylesheet defaults and hairline colours no longer serialize like the app's.
    applyThemeTokens(undefined, theme);
    flushSync(() => root.render(<I18nProvider locale={locale}><SurfaceView surface={surface} locale={locale}/></I18nProvider>));
  },
};

window.qaPanelSurfaces.render('block-inspector');
