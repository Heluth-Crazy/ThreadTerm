import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { createRequire } from 'node:module';
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import('react-dom/server');
import type { CatalogVisibility, Session } from '@threadterm/protocol';
import { DelegateGroupActions, planDelegateGroup } from './DelegateGroupActions';
import { I18nProvider } from '../i18n';

const session = (id: string, status: Session['status'], extra: Partial<Session> = {}): Session =>
  ({ id, title: `Delegate ${id}`, provider: 'pi', mode: 'chat', status, createdAt: 'now', updatedAt: 'now', projectId: 'p', organizationRevision: 3, ...extra });

test('the plan updates each finished delegate at its current revision and skips ones already gone', () => {
  const sessions = [session('a', 'exited'), session('b', 'exited', { organizationRevision: 7 }), session('c', 'exited')];
  const visibility: CatalogVisibility[] = [{ kind: 'session', id: 'a', visibility: 'active', revision: 11 }];
  const plan = planDelegateGroup(['a', 'b', 'gone', 'c'], sessions, visibility);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.updates.map(row => [row.id, row.expectedRevision]), [['a', 11], ['b', 7], ['c', 3]]);
});

test('a delegate that became active or has unsaved edits blocks the whole group', () => {
  const sessions = [session('a', 'exited'), session('b', 'running'), session('c', 'exited')];
  const plan = planDelegateGroup(['a', 'b', 'c'], sessions, [], row => row.id === 'c');
  assert.deepEqual(plan.blocked.map(row => [row.id, row.reason]), [['b', 'active'], ['c', 'edited']]);
  const readOnly = planDelegateGroup(['b'], [session('b', 'running', { readOnly: true })], []);
  assert.deepEqual(readOnly.blocked, [], 'a read-only observer row is not an active session');
});

test('the fold row shows its manage button only when the group still has sessions', () => {
  const props = { parentTitle: 'Parent', sessions: [session('a', 'exited')], onChanged() {} };
  const render = (sessionIds: string[]) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh-CN', children: createElement(DelegateGroupActions, { ...props, sessionIds }) }));
  assert.match(render(['a']), /data-testid="delegate-group-more"[^>]*><svg/);
  assert.match(render(['a']), /aria-label="1 个已结束的委派 管理"/);
  assert.equal(render(['gone']), '');
});
