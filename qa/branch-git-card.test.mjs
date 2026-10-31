import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const card = await readFile(new URL('../renderer/src/components/BranchGitCard.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../renderer/src/components/project-overview.css', import.meta.url), 'utf8');
const overview = await readFile(new URL('../renderer/src/components/ProjectOverview.tsx', import.meta.url), 'utf8');

test('branch Git card makes commit rows History buttons and sync states Changes buttons', () => {
  assert.match(card, /onOpenHistory\?:\(commit:string\) => void/);
  assert.match(card, /return onOpenHistory\s*\? <button/);
  assert.match(card, /<button type="button" key=\{commit\.hash\} className="ov-row ov-git-commit"[\s\S]*onClick=\{\(\) => onOpenHistory\(commit\.hash\)\}/);
  assert.match(card, /aria-label=\{zh \? `在历史中打开提交：\$\{commit\.subject\}` : `Open commit in History: \$\{commit\.subject\}`\}/);
  assert.match(card, /className="ov-git-sync-link" onClick=\{\(\) => onOpenChanges\(\)\}/);
  assert.equal((card.match(/className="ov-git-chip" onClick=\{\(\) => onOpenChanges\(\)\}/g) ?? []).length, 2);
  assert.match(css, /\.ov-row\.ov-git-commit \{ min-height:44px; \}/);
  assert.doesNotMatch(css, /^\.ov-row\.ov-git-commit:hover \{ background:transparent; \}/m);
});

test('without a History callback commits are passive divs with title only and no hover fill', () => {
  assert.match(card, /: <div key=\{commit\.hash\} className="ov-row ov-git-commit" title=\{commit\.subject\}>\{content\}<\/div>/);
  assert.match(css, /div\.ov-row\.ov-git-commit \{ cursor:default; \}/);
  assert.match(css, /div\.ov-row\.ov-git-commit:hover \{ background:transparent; \}/);
});

test('overview exposes History only with a non-archived session in the canonical project/worktree scope', () => {
  assert.match(overview, /const sessions=data\.sessions\.filter\(s=>s\.projectId===projectId&&!s\.archived&&!isCodeReviewSession\(s\)&&\(!initialWorktreePath\|\|sameCanonicalScope\(s\.worktreePath\?\?project\.path,initialWorktreePath\)\)\)/);
  assert.match(overview, /onOpenHistory=\{onOpenHistory && sessions\.length > 0 \? commit=>onOpenHistory\(\{projectId,worktreePath:path,commit\}\) : undefined\}/);
});
