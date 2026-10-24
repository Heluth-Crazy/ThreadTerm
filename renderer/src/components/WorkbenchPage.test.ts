import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import type { Session, Snapshot } from '@threadterm/protocol';
import { I18nProvider } from '../i18n';
import { WorkbenchPage } from './WorkbenchPage';

const session = (status: Session['status']): Session => ({ id: 'session-a', title: 'Working tree', provider: 'shell', mode: 'terminal', status, createdAt: '2026-10-23T08:00:00Z', updatedAt: '2026-10-23T08:05:00Z' });
const snapshot = (language: string, statuses: Session['status'][] = []): Snapshot => ({
  settings: { language, revision: 1 },
  projects: [],
  sessions: statuses.map(session),
  inbox: [],
  providers: [],
} as unknown as Snapshot);

function render(language: string, statuses: Session['status'][] = []) {
  const page = createElement(WorkbenchPage, { data: snapshot(language, statuses), onCreate: () => {}, onProject: () => {}, onSession: () => {}, onAddProject: () => {}, onAll: () => {}, onInbox: () => {} });
  return renderToStaticMarkup(createElement(I18nProvider, { locale: language === 'zh-CN' ? 'zh-CN' : 'en', children: page }));
}

// F22: the home field only names the session; it must not read like an initial task prompt.
test('the Workbench home field is labelled as a session title in both languages', () => {
  const en = render('en');
  assert.match(en, /placeholder="Session title \(optional\)[^"]*first message/);
  assert.match(en, /aria-label="Session title"/);
  assert.doesNotMatch(en, /Describe a session to start/i);
  const zh = render('zh-CN');
  assert.match(zh, /placeholder="会话标题（可选）[^"]*第一条消息/);
  assert.match(zh, /aria-label="会话标题"/);
  assert.doesNotMatch(zh, /描述要开的会话/);
});

// Locale: list rows use the i18n labels instead of raw runtime status strings.
test('Workbench session rows show translated status labels', () => {
  const labels: [Session['status'], string, string][] = [
    ['starting', 'Starting', '正在启动'], ['running', 'Running', '运行中'], ['idle', 'Idle', '空闲'],
    ['waiting', 'Waiting', '等待中'], ['exited', 'Exited', '已退出'], ['interrupted', 'Interrupted', '已中断'], ['error', 'Error', '错误'],
  ];
  for (const [status, en, zh] of labels) {
    assert.match(render('en', [status]), new RegExp(`class="chip st-[a-z]+">${en}<`), `en label for ${status}`);
    assert.match(render('zh-CN', [status]), new RegExp(`class="chip st-[a-z]+">${zh}<`), `zh label for ${status}`);
  }
});
