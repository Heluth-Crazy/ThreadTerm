import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import type { ProjectCatalogItem } from '@threadterm/protocol';
import { ProjectCatalog } from './ProjectCatalog';
import { projectCatalogStore } from '../projectCatalogStore';
import { I18nProvider } from '../i18n';

test('catalog renders loading rather than false empty, and a remount renders its cached list synchronously', async () => {
  const render = (locale: 'en' | 'zh-CN') => renderToStaticMarkup(createElement(I18nProvider, { locale, children: createElement(ProjectCatalog, { onAll() {}, onProject() {} }) }));
  let next: ProjectCatalogItem[] = [];
  const request = (async (method: string) => method === 'project.catalog.list' ? next : []) as Parameters<typeof projectCatalogStore>[1];
  const store = projectCatalogStore('local', request);
  assert.match(render('en'), /Loading projects/); assert.doesNotMatch(render('en'), /No projects yet/);
  assert.match(render('zh-CN'), /正在加载项目/); assert.doesNotMatch(render('zh-CN'), /还没有项目/);
  const stop = store.activate(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(render('en'), /No projects yet/);
  next = [{ id: 'cached', name: 'Saved catalog project', path: 'C:/cached', pinned: false, sortOrder: 0, git: { available: false } } as ProjectCatalogItem];
  await store.reload(); stop();
  assert.match(render('en'), /Saved catalog project/); assert.doesNotMatch(render('en'), /No projects yet/);
  assert.match(render('zh-CN'), /Saved catalog project/); assert.doesNotMatch(render('zh-CN'), /还没有项目/);
});
