import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = (name: string) => readFileSync(`mobile/src/ui/${name}`, 'utf8');

test('concise bilingual labels keep the existing actions reachable', () => {
  const needs = source('NeedsYouScreen.tsx');
  assert.match(needs, /'计划' : 'Plan'/);
  assert.match(needs, /'问题' : 'Question'/);
  assert.match(needs, /'批准' : 'Approval'/);
  assert.match(needs, /label=\{locale === 'zh-CN' \? '添加电脑' : 'Add computer'\}/);

  const projects = source('ProjectsScreen.tsx');
  assert.match(projects, /"Add a computer to start\."/);
  assert.match(projects, /"Start a new session\."/);
  assert.doesNotMatch(projects, /Registered projects on your computers/);

  const options = source('ChatOptionsSheet.tsx');
  assert.match(options, /'No session options\.'[^]*'没有会话选项。'/);
  assert.match(options, /label=\{copy\(locale, 'Refresh', '刷新'\)\}/);
});
