import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function settled(request, groupId, body, expected = 1, outputsReady = () => true) {
  const deadline = Date.now() + 30_000;
  let last;
  for (;;) {
    const group = await request('group.read', { id: groupId });
    const message = [...group.messages].reverse().find(row => row.author === 'user' && row.body === body);
    const terminal = message?.deliveries?.length === expected && message.deliveries.every(row => ['replied', 'failed', 'stopped'].includes(row.state));
    const replies = terminal
      ? message.deliveries.map(delivery => replyFor(group, message.id, delivery.handle)) : [];
    const basicOutputs = replies.every(reply => reply.outputs && Array.isArray(reply.outputs.files) && Array.isArray(reply.outputs.changed));
    if (terminal && basicOutputs && outputsReady(replies)) return { group, message };
    last = { message, replies: replies.map(reply => ({ handle: reply.handle, outputs: reply.outputs })) };
    if (Date.now() >= deadline) throw Error(`GC6 delivery did not settle: ${body}\nlastGroupState=${JSON.stringify(last)}`);
    await delay(80);
  }
}

function replyFor(group, messageId, handle) {
  const row = group.messages.find(row => row.author === 'member' && row.replyTo === messageId && row.handle === handle);
  assert.ok(row, `reply exists for @${handle}`);
  return row;
}

function detail(reply, path, status, evidence) {
  const output = JSON.stringify(reply.outputs);
  assert.ok(reply.outputs.changed.includes(path), `${path} remains compatible in changed[]; outputs=${output}`);
  assert.ok(reply.outputs.changedDetails?.some(row => row.path === path && row.status === status && row.evidence === evidence), `${path} has ${status}/${evidence} detail; outputs=${output}`);
}

const hasDetail = (path, status, evidence) => replies => replies.some(reply =>
  reply.outputs.changedDetails?.some(row => row.path === path && row.status === status && row.evidence === evidence));

async function create(request, cwd, providers, title, projectId) {
  return request('group.create', {
    cwd, projectId, title,
    members: providers.map(provider => ({ provider })),
    operationId: randomUUID(),
  });
}

async function send(request, id, text, handles, outputsReady) {
  await request('group.send', { id, text, to: handles, references: [], operationId: randomUUID() });
  return settled(request, id, text, handles.length, outputsReady);
}

/** Folder-diff regressions for opaque shell writes, deletes and overlapping turns. */
export async function checkGroupGc6({ request, gitCwd, nonGitCwd, gitProjectId, check }) {
  const git = await create(request, gitCwd, ['group-qa-a', 'group-qa-b'], 'GC6 Git changes', gitProjectId);
  const [a, b] = git.members.map(member => member.handle);

  let result = await send(request, git.id, 'shell opaque write', [a], hasDetail(`shell/${a}-generated.html`, 'added', 'folder'));
  detail(replyFor(result.group, result.message.id, a), `shell/${a}-generated.html`, 'added', 'folder');

  await send(request, git.id, 'prepare deletion', [a]);
  result = await send(request, git.id, 'delete fixture', [a], hasDetail(`delete/${a}.txt`, 'deleted', 'folder'));
  detail(replyFor(result.group, result.message.id, a), `delete/${a}.txt`, 'deleted', 'folder');

  result = await send(request, git.id, 'concurrent shell write', [a, b], replies =>
    replies.every(reply => reply.outputs.possiblyChanged?.includes('shared/concurrent.html')));
  for (const handle of [a, b]) {
    const reply = replyFor(result.group, result.message.id, handle);
    assert.ok(reply.outputs.possiblyChanged?.includes('shared/concurrent.html'), `@${handle} keeps ambiguous shared shell write`);
    assert.deepEqual(reply.outputs.changedDetails?.filter(row => row.path === 'shared/concurrent.html') ?? [], [], `@${handle} does not falsely claim shared shell write`);
  }

  result = await send(request, git.id, 'claims only overlap', [a, b], replies =>
    replies.every(reply => reply.outputs.changedDetails?.some(row => row.path === `claimed-only/${reply.handle}.html` && row.status === 'added' && row.evidence === 'tool')));
  for (const handle of [a, b]) {
    const reply = replyFor(result.group, result.message.id, handle);
    detail(reply, `claimed-only/${handle}.html`, 'added', 'tool');
    assert.equal(reply.outputs.possiblyChanged?.length ?? 0, 0, `@${handle} has no uncertainty for exclusive claimed edit`);
  }

  result = await send(request, git.id, 'claimed overlap shell overlap', [a, b], replies =>
    replies.some(reply => reply.handle === a && reply.outputs.changedDetails?.some(row => row.path === `claimed/${a}.html` && row.evidence === 'tool')) &&
    replies.some(reply => reply.handle === b && reply.outputs.changedDetails?.some(row => row.path === `shell/${b}.html` && row.evidence === 'folder')));
  detail(replyFor(result.group, result.message.id, a), `claimed/${a}.html`, 'added', 'tool');
  detail(replyFor(result.group, result.message.id, b), `shell/${b}.html`, 'added', 'folder');
  check('Git folder diff: opaque shell write, deletion, concurrent ambiguity, claims-only and mixed-overlap attribution');

  const project = await request('project.add', { path: nonGitCwd, name: 'GC6 non-Git', operationId: randomUUID() });
  const nonGit = await create(request, nonGitCwd, ['group-qa-a', 'group-qa-b'], 'GC6 non-Git changes', project.id);
  const [nonGitA, nonGitB] = nonGit.members.map(member => member.handle);
  result = await send(request, nonGit.id, 'shell opaque write', [nonGitA], hasDetail(`shell/${nonGitA}-generated.html`, 'added', 'folder'));
  detail(replyFor(result.group, result.message.id, nonGitA), `shell/${nonGitA}-generated.html`, 'added', 'folder');
  assert.equal(replyFor(result.group, result.message.id, nonGitA).outputs.changedIncomplete, undefined, 'small non-Git manifest is complete');
  await send(request, nonGit.id, 'prepare deletion', [nonGitA]);
  result = await send(request, nonGit.id, 'delete fixture', [nonGitA], hasDetail(`delete/${nonGitA}.txt`, 'deleted', 'folder'));
  detail(replyFor(result.group, result.message.id, nonGitA), `delete/${nonGitA}.txt`, 'deleted', 'folder');
  result = await send(request, nonGit.id, 'concurrent shell write', [nonGitA, nonGitB], replies =>
    replies.every(reply => reply.outputs.possiblyChanged?.includes('shared/concurrent.html')));
  for (const handle of [nonGitA, nonGitB]) {
    assert.ok(replyFor(result.group, result.message.id, handle).outputs.possiblyChanged?.includes('shared/concurrent.html'), `non-Git @${handle} keeps ambiguous shared shell write`);
  }
  check('non-Git manifest folder diff: opaque shell write, deletion, and concurrent ambiguity');
  return { gitGroupId: git.id, nonGitGroupId: nonGit.id };
}
