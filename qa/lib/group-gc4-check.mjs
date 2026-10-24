import assert from 'node:assert/strict';

/** Assert the quiet Group suggestion keeps the user in control. */
export async function checkGroupSuggestion({ article, box, group, message, read, until }) {
  const reply = [...(await read()).messages]
    .reverse()
    .find(row => row.author === 'member' && row.replyTo === message.id);
  assert.ok(reply, 'suggestion source reply exists');
  const suggestion = article(reply.id).getByRole('button', {
    name: 'Suggested next: @group-qa-a', exact: true,
  });
  await suggestion.waitFor();
  assert.match(await suggestion.getAttribute('title'), /Please review/);
  assert.doesNotMatch(await suggestion.innerText(), /Please review/);
  const messageCount = (await read()).messages.length;
  await suggestion.click();
  await until(async () => await box().inputValue() === '', 'suggestion blank draft');
  await until(async () => /@group-qa-a/.test(await group().getByTestId('group-to').innerText()), 'suggestion recipient');
  assert.match(await group().getByTestId('group-to').innerText(), /@group-qa-a/);
  await group().getByTestId('group-includes').waitFor();
  const reference = group().getByTestId('group-includes').locator('[data-reference-id]');
  assert.equal(await reference.count(), 1, 'suggestion attaches exactly its reply');
  assert.equal((await read()).messages.length, messageCount, 'suggestion never auto-sends');
  const title = await reference.first().getAttribute('title');
  assert.match(title ?? '', /\(to:/, 'full reference title remains a tooltip');
  assert.doesNotMatch(await reference.first().innerText(), /\(to:/, 'reference label stays compact');
  await box().fill('Revise the page');
  await until(async () => /@group-qa-a/.test(await group().getByTestId('group-to').innerText()), 'plain suggestion drafting retains the target');
  assert.equal((await read()).messages.length, messageCount, 'typing a suggestion draft never sends');
  await box().fill('');
}
