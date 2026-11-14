import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import { ReviewDiffView } from './ReviewDiffView';

const render = (zh: boolean, stack = true, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ReviewDiffView, {
  projectId: 'project-a', path: 'src/SheetView.tsx', sessionId: 'session-a', checkpointId: 'checkpoint-a',
  toCheckpointId: 'checkpoint-b', editorId: 'review-editor', zh, stack, ...extra,
}));

// G3: Cursor's Git review — a sticky summary, then every changed file as one hairline section.
test('the stacked review shows the file count, the layout switch and the expanded file', () => {
  const en = render(false);
  assert.match(en, /class="[^"]*wb-review-stack/);
  assert.match(en, /1 file changed/);
  assert.match(en, /class="cg-seg"/);
  assert.match(en, /aria-pressed="true"[^>]*>Unified/);
  assert.match(en, />Split</);
  assert.match(en, /class="[^"]*cg-hair[^"]*wb-rs-file/);
  assert.match(en, /SheetView\.tsx/);
  assert.match(en, /src<\/span>|>src</);
  assert.match(en, /class="wb-rs-body"/, 'the opened file mounts its diff');
  assert.match(en, /Checkpoint → next checkpoint/);
});

test('the stacked review is translated and the inline turn diff keeps its single-pane navigation', () => {
  const zh = render(true);
  assert.match(zh, /1 个文件已更改/);
  assert.match(zh, />统一</);
  assert.match(zh, />并排</);
  const inline = render(false, false);
  assert.doesNotMatch(inline, /wb-review-stack/);
  assert.match(inline, /data-testid="review-diff-surface"/);
  assert.match(inline, /aria-label="File navigation"/, 'the inline turn diff keeps file navigation');
});
