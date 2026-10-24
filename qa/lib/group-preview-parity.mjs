// F11: both routes use the existing workspace browser page strip.
import assert from 'node:assert/strict';
export async function capturePreviewParity({ page, request, first, back, take, until }) {
  const url = first.outputs?.urls?.[0];
  assert.ok(url, 'member reply exposes a URL output');
  await back();
  const group = page.locator('[data-testid=group-view]:visible');
  await take('group-output-url-preview');
  await group.getByRole('button', {name:`Open @${first.handle}'s chat`,exact:true}).click();
  const chat = page.getByTestId(`session-chat-${first.sessionId}`);
  await chat.waitFor();
  const link = chat.getByRole('link', {name:url,exact:true}).first();
  await link.click();
  await page.getByRole('menuitem', {name:'Open in preview',exact:true}).click();
  await page.locator('.wb-web-preview:visible').waitFor();
  await request('session.present',{sessionId:first.sessionId,placement:'workspace',presentation:'focused',operationId:crypto.randomUUID()});
  await chat.waitFor();
  await take('chat-link-open-in-preview');
  const tabs=await page.getByRole('tab').allTextContents();
  assert.ok(tabs.some(text=>/Group page output/.test(text)), 'Chat keeps the same browser page strip');
  await back();
  return {url,tabs,sharedPageStrip:true};
}
