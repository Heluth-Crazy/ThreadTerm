import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Exercises paged Group history inside an already-isolated visual-harness app. */
export async function checkGroupHistory({ page, request, groupId, handle, check, take }) {
  for (let index = 1; index <= 56; index++) {
   await request('group.send', {
    id: groupId,
    text: `History fixture ${index}`,
    to: [handle],
    references: [],
    operationId: randomUUID(),
   });
   // History coverage must not overflow the native Chat queue's admission bound.
   const turnDeadline = Date.now() + 30_000;
   for (;;) {
    const current = await request('group.read', { id: groupId });
    const message = [...current.messages].reverse().find(message => message.author === 'user' && message.body === `History fixture ${index}`);
    const state = message?.deliveries?.find(delivery => delivery.handle === handle)?.state;
    if (state === 'replied') break;
    if (state === 'failed' || Date.now() > turnDeadline) throw Error(`History fixture ${index}: ${state ?? 'missing delivery'}`);
    await delay(80);
   }
  }

  const deadline = Date.now() + 90_000;
  for (;;) {
    const current = await request('group.read', { id: groupId });
    const last = [...current.messages].reverse().find(message => message.author === 'user' && message.body === 'History fixture 56');
    if (last?.deliveries?.some(delivery => delivery.handle === handle && delivery.state === 'replied')) break;
    if (Date.now() > deadline) throw Error('Timed out waiting for the final history fixture delivery.');
    await delay(100);
  }
  check('history fixture replies completed');

  await page.reload();
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 60_000 });
  await page.locator(`.group-row[data-group-id="${groupId}"]`).click();
  const view = page.locator(`[data-testid="group-view"][data-group-id="${groupId}"]`);
  await view.waitFor({ state: 'visible', timeout: 30_000 });
  const timeline = view.getByTestId('group-timeline');
  const messages = timeline.locator('[data-testid^="group-message-"]');
  await timeline.locator('.gc-load-older').waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await messages.count(), 100, 'the initial Group page is capped at 100 messages');
  await delay(300);
  assert.equal(await messages.count(), 100, 'older history is not read before an explicit top scroll');
  check('initial group history stays at the newest 100 messages');

  const first = messages.first(), anchorId = await first.getAttribute('data-message-id');
  assert.ok(anchorId, 'history anchor id must exist before paging');
  const anchorY = await timeline.evaluate(node => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
    return node.querySelector('[data-testid^="group-message-"]')?.getBoundingClientRect().y;
  });
  assert.notEqual(anchorY, undefined, 'history anchor must exist before paging');
  const olderDeadline = Date.now() + 30_000;
  while (await messages.count() <= 100) {
    if (Date.now() > olderDeadline) throw Error('Timed out loading older Group history.');
    await delay(50);
  }
  const anchorBox = await timeline.locator(`[data-message-id="${anchorId}"]`).boundingBox();
  assert.ok(anchorBox, 'history anchor must remain rendered after paging');
  assert.ok(Math.abs(anchorBox.y - anchorY) <= 2, `older-page insertion moved the scroll anchor by ${Math.abs(anchorBox.y - anchorY)}px`);
  assert.ok(await messages.count() >= 112, 'all seeded user and reply messages are visible after loading older history');
  await take('history-loaded-older');
  check('older group history loads at the top without moving the reading anchor');
}
