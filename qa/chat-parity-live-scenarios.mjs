// Scenarios for qa/chat-parity-live.mjs (LIVE: real agent CLIs, real quota). Each scenario receives the harness
// helpers and records PASS/FAIL checks plus NOTE findings into its report.json; soft failures never throw.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LIVE_PROVIDERS = ['claude', 'codex', 'opencode', 'pi', 'grok', 'kimi'];
const save = (dir, name, value) => writeFile(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
const summarizeOptions = ui => ({
  loadState: ui.loadState,
  inputCapabilities: ui.inputCapabilities,
  options: ui.options?.map(option => ({ id: option.id, name: option.name, kind: option.kind, category: option.category, value: option.value, choices: option.choices?.map(choice => choice.value).slice(0, 12) })),
  commands: ui.commands?.length,
  skills: ui.skills?.map(skill => `${skill.name} -> ${skill.invocation}`).slice(0, 12),
  piTrust: ui.piTrust,
  error: ui.error,
});

const textOf = item => (item?.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('');
const turnItems = (items, turnId) => items.filter(item => item.turnId === turnId);
const replyText = (items, turnId) => turnItems(items, turnId).filter(item => item.role === 'assistant').map(textOf).join('\n');
const allParts = items => items.flatMap(item => (item.parts ?? []).map(part => ({ ...part, itemId: item.id, turnId: item.turnId, role: item.role })));
const toolParts = items => allParts(items).filter(part => part.type === 'tool');
const pendingApprovals = items => allParts(items).filter(part => part.type === 'approval' && part.status === 'pending');
const readFile = path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
const toolSummary = parts => parts.map(part => `${part.toolName ?? '?'}:${part.status ?? '?'}`);

const TURN_PROMPT = 'Work in this repository and do these four steps, tracking them with your todo or plan tool as you go: '
  + '(1) read README.md and find the magic number; (2) search the repository for TODO comments; '
  + '(3) create a file notes.txt whose only content is the magic number; (4) run the shell command `git status --short`. '
  + 'Finish with a two-sentence summary that includes the magic number.';
const LONG_COMMAND = 'node -e "setTimeout(() => console.log(\'finished\'), 25000)"';

async function setOption(h, ctx, optionId, value) {
  const ui = await h.request('chat.option.set', { sessionId: ctx.session.id, optionId, value, leaseEpoch: await ctx.lease(), operationId: randomUUID() });
  return ui.options?.find(option => option.id === optionId)?.value;
}

// Waits for one turn to settle. Pending approvals are answered by `onApproval` (default: allow once through RPC).
async function settle(h, ctx, turnId, { timeout = 360_000, onApproval, stopWhen } = {}) {
  const approvals = [];
  const end = Date.now() + timeout;
  let lastLease = 0;
  for (;;) {
    if (Date.now() > end) throw new Error(`${ctx.provider} turn ${turnId} timed out`);
    if (Date.now() - lastLease > 15_000) { await ctx.lease(); lastLease = Date.now(); }
    const items = await ctx.snapshot();
    const status = await ctx.status();
    if (stopWhen) { const hit = await stopWhen(items, status); if (hit) return { items, status, approvals, hit }; }
    const pending = pendingApprovals(items);
    if (pending.length) {
      for (const part of pending) {
        if (approvals.some(row => row.approvalId === part.approvalId)) continue;
        approvals.push({ approvalId: part.approvalId, interaction: part.data?.interaction, requestType: part.data?.requestType, title: part.data?.title, choices: part.data?.choices?.map(choice => `${choice.kind}/${choice.scope}:${choice.label}`) });
        const handler = onApproval ?? (async (p) => allowOnce(h, ctx, p));
        await handler(part, items);
      }
    } else if (status === 'idle' || status === 'awaiting_input') {
      const own = turnItems(items, turnId);
      const settled = own.some(item => item.role !== 'user') && !own.some(item => item.turnStatus === 'inProgress');
      if (settled) return { items, status, approvals };
    }
    if (status === 'error' || status === 'exited' || status === 'interrupted') return { items, status, approvals, ended: status };
    await h.delay(1200);
  }
}

async function allowOnce(h, ctx, part) {
  const choices = part.data?.choices ?? [];
  const choice = choices.find(row => row.kind === 'allow' && row.scope === 'once') ?? choices.find(row => row.kind === 'allow') ?? choices[0];
  if (!choice) return;
  await h.request('chat.approve', { sessionId: ctx.session.id, turnId: part.data?.turnId ?? part.turnId, approvalId: part.approvalId, choiceId: choice.choiceId, leaseEpoch: await ctx.lease(), operationId: randomUUID() });
}

// Clicks one choice on the visible approval card (the real UI path).
async function clickChoice(ctx, part, kind) {
  const choice = (part.data?.choices ?? []).find(row => row.kind === kind && (row.scope === 'once' || kind !== 'allow')) ?? (part.data?.choices ?? []).find(row => row.kind === kind);
  if (!choice) throw new Error(`no ${kind} choice in ${JSON.stringify(part.data?.choices)}`);
  const button = ctx.scope.locator('.chat-approval-card.pending .chat-approval-choice', { hasText: choice.label }).first();
  await button.waitFor({ timeout: 20_000 });
  await button.click();
  return choice;
}

async function footerAndContext(h, ctx, items, turnId, { expect, note, report, windowExpected = true }) {
  const assistant = turnItems(items, turnId).filter(item => item.role === 'assistant');
  const last = assistant.at(-1);
  const model = assistant.map(item => item.turnModel).find(Boolean);
  const usage = assistant.map(item => item.turnUsage).find(Boolean);
  const review = assistant.map(item => item.turnReview).find(Boolean);
  report.data[`${ctx.provider}-footer`] = { model, usage, review, elapsedMs: last?.elapsedMs, turnStatus: last?.turnStatus };
  expect(Boolean(model), `${ctx.provider} footer has the turn model (${model})`, { model });
  expect(Boolean(usage && (usage.totalTokens || usage.inputTokens || usage.outputTokens)), `${ctx.provider} footer has turn token usage`, usage ?? 'no turnUsage');
  const context = await h.until(() => h.request('chat.context.read', { sessionId: ctx.session.id }), `${ctx.provider} context usage`, 20_000).catch(() => null);
  report.data[`${ctx.provider}-context`] = context;
  if (windowExpected) expect(Boolean(context?.windowTokens && context?.usedTokens), `${ctx.provider} context ring has used/window tokens`, context ?? 'null');
  else expect(Boolean(context && (context.totalTokens || context.usedTokens || context.inputTokens)), `${ctx.provider} context ring has a token count`, context ?? 'null');
  const ringVisible = await ctx.scope.locator('.chat-context-ring, [class*="context-ring"]').count();
  expect(ringVisible > 0, `${ctx.provider} context ring is rendered`);
  const footers = await ctx.scope.locator('[data-testid="chat-turn-footer"]').count();
  expect(footers > 0, `${ctx.provider} turn footer is rendered`);
  return { model, usage, review, context };
}

// ---------- generic scenario builders ----------

function turnScenario(provider, { options = {}, planExpected = true, windowExpected = true, checkpointExpected = true } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live turn`, { dir });
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const { turnId } = await ctx.send(TURN_PROMPT);
      const result = await settle(h, ctx, turnId);
      await save(dir, 'items.json', result.items);
      report.data.approvals = result.approvals;
      expect(!result.ended, `${provider} turn ended normally`, result.ended);
      const tools = toolParts(turnItems(result.items, turnId));
      report.data.tools = toolSummary(tools);
      note(`${provider} tools: ${toolSummary(tools).join(', ')}`);
      expect(tools.length >= 3, `${provider} shows at least three tool cards`, toolSummary(tools));
      expect(!tools.some(part => part.status === 'running' || part.status === 'pending'), `${provider} leaves no tool card running`, toolSummary(tools));
      const plan = allParts(turnItems(result.items, turnId)).filter(part => part.type === 'plan');
      report.data.plan = plan.at(-1)?.data;
      if (planExpected) expect(plan.length > 0, `${provider} todo/plan updates render as a plan part`, `plan parts: ${plan.length}`);
      else note(`${provider} plan parts: ${plan.length}`);
      const reply = replyText(result.items, turnId);
      expect(/4817/.test(reply), `${provider} reply names the magic number`, reply.slice(-400));
      expect((readFile(join(ctx.cwd, 'notes.txt')) ?? '').includes('4817'), `${provider} created notes.txt with the magic number`, readFile(join(ctx.cwd, 'notes.txt')) ?? 'missing');
      await footerAndContext(h, ctx, result.items, turnId, { ...h, windowExpected });
      // The after-turn checkpoint is captured in the background, so its review lands a little later.
      const review = await h.until(async () => turnItems(await ctx.snapshot(), turnId).map(item => item.turnReview).find(Boolean), 'turn review', 45_000).catch(() => undefined);
      report.data.review = review;
      if (checkpointExpected) expect(Boolean(review?.fileCount >= 1), `${provider} footer has a checkpoint diff with the new file`, review ?? 'no turnReview after 45 s');
      // Each text item renders as its own block; only text inside one item can run together.
      for (const item of turnItems(result.items, turnId).filter(row => row.role === 'assistant')) {
        const text = textOf(item);
        if (/[a-z`][.!?:][A-Z]/.test(text)) note(`${provider} reply text has sentences joined without a break: ${text.match(/.{0,30}[a-z`][.!?:][A-Z].{0,20}/)?.[0]}`);
      }
      // Options chosen before the turn must still read back afterwards (and show on the chips).
      const after = await h.request('chat.options', { sessionId: ctx.session.id });
      for (const [id, value] of Object.entries(options)) {
        const current = after.options?.find(option => option.id === id)?.value;
        expect(current === value, `${provider} option ${id} still reads ${JSON.stringify(value)} after the turn`, { current });
      }
      await ctx.shot('turn', { widths: [1100, 420] });
      await ctx.shot('turn', { widths: [1100], theme: 'dark' });
    } finally { await ctx.stop(); }
  };
}

function steerScenario(provider, { options = {} } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live steer`, { dir });
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const { turnId } = await ctx.send(`Run this exact shell command and wait for it to finish: ${LONG_COMMAND}\nThen reply with the single word DONE.`);
      // Steer while the long command runs.
      const running = await settle(h, ctx, turnId, { stopWhen: items => toolParts(turnItems(items, turnId)).some(part => part.status === 'running' || part.status === 'pending' || part.status === 'inProgress' || part.status === 'in_progress') });
      expect(Boolean(running.hit), `${provider} long command started before the steer`, toolSummary(toolParts(running.items)));
      const steer = await ctx.steer(turnId, 'Also add the word BANANA at the end of your reply.');
      report.data.steer = steer;
      expect(steer.disposition === 'delivered', `${provider} steer was delivered natively`, steer);
      await ctx.shot('steer-running', { widths: [1100] });
      const result = await settle(h, ctx, turnId);
      await save(dir, 'items.json', result.items);
      const steeredRows = result.items.filter(item => item.role === 'user' && item.parts.some(part => part.data?.steered === true));
      report.data.steeredRows = steeredRows.map(item => ({ id: item.id, turnId: item.turnId, data: item.parts[0]?.data }));
      expect(steeredRows.length === 1, `${provider} transcript shows one steered user row`, report.data.steeredRows);
      expect(steeredRows[0]?.turnId === turnId, `${provider} steered row belongs to the running turn`, report.data.steeredRows);
      const replies = result.items.filter(item => item.role === 'assistant').map(item => `${item.turnId}: ${textOf(item).slice(-160)}`);
      report.data.replies = replies;
      const allReply = result.items.filter(item => item.role === 'assistant').map(textOf).join('\n');
      expect(/BANANA/.test(allReply), `${provider} reply honours the steer (BANANA)`, replies);
      const turnIds = [...new Set(result.items.map(item => item.turnId).filter(Boolean))];
      note(`${provider} turns after steer: ${turnIds.length} (${turnIds.join(', ')})`);
      expect(/BANANA/.test(replyText(result.items, turnId)) || turnIds.length === 2, `${provider} steer reply is attributed to the steered turn or one carry turn`, replies);
      await ctx.shot('steer-done', { widths: [1100, 420] });
      // A normal follow-up after the steer must land in its own new turn.
      const follow = await ctx.send('Reply with the single word CHERRY.');
      const after = await settle(h, ctx, follow.turnId);
      await save(dir, 'items-after.json', after.items);
      const followReply = replyText(after.items, follow.turnId);
      expect(/CHERRY/.test(followReply), `${provider} follow-up after the steer gets its own reply`, followReply.slice(-200));
      expect(!/CHERRY/.test(replyText(after.items, turnId)), `${provider} follow-up reply is not credited to the steered turn`);
      expect(after.status === 'idle' || after.status === 'awaiting_input', `${provider} session is idle after the follow-up (${after.status})`);
    } finally { await ctx.stop(); }
  };
}

function forkScenario(provider, { options = {}, expectMode = 'native' } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live fork`, { dir });
    let forked;
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const first = await ctx.send('Remember the codeword APPLE. Reply with just OK. Do not use any tools.');
      let result = await settle(h, ctx, first.turnId);
      const second = await ctx.send('Remember a second codeword, PEAR. Reply with just OK. Do not use any tools.');
      result = await settle(h, ctx, second.turnId);
      await save(dir, 'source-items.json', result.items);
      // The reply the user would fork from: the turn's last assistant item with visible text.
      const firstReply = turnItems(result.items, first.turnId).filter(item => item.role === 'assistant' && textOf(item).trim()).at(-1);
      expect(Boolean(firstReply), `${provider} first reply exists`);
      report.data.forkAnchor = firstReply?.forkAnchor;
      expect(Boolean(firstReply?.forkAnchor), `${provider} first reply carries a native fork anchor`, firstReply?.forkAnchor ?? 'none');
      const fork = await h.request('chat.fork', { sessionId: ctx.session.id, itemId: firstReply.id, operationId: randomUUID(), leaseEpoch: await ctx.lease() });
      report.data.fork = { mode: fork.mode, session: { id: fork.session.id, title: fork.session.title, nativeId: fork.session.nativeId, forkedFrom: fork.session.forkedFrom } };
      expect(fork.mode === expectMode, `${provider} fork mode is ${expectMode} (${fork.mode})`);
      forked = { session: fork.session };
      await h.request('session.present', { sessionId: fork.session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
      const forkCtx = await h.attachChat(fork.session, { dir, cwd: ctx.cwd });
      forked = forkCtx;
      const phases = [];
      try {
        await h.until(async () => {
          const state = await h.request('chat.connection', { sessionId: fork.session.id });
          if (phases.at(-1) !== state.phase) phases.push(state.phase);
          return state.phase === 'ready';
        }, 'fork connection', 45_000, 500);
      } catch {
        const state = await h.request('chat.connection', { sessionId: fork.session.id });
        report.data.forkConnection = { phases, state, status: await forkCtx.status() };
        expect(false, `${provider} fork connects by itself after it opens`, report.data.forkConnection);
        await ctx.shot('fork-not-connected', { widths: [1100] });
        try { await h.request('chat.connect', { sessionId: fork.session.id, leaseEpoch: await forkCtx.lease(), operationId: randomUUID() }); } catch (error) { note(`${provider} explicit chat.connect on the fork failed: ${error.message}`); }
      }
      await forkCtx.connect();
      await ctx.shot('fork-opened', { widths: [1100] });
      if (fork.mode === 'native') {
        const forkItems = await forkCtx.snapshot();
        await save(dir, 'fork-items.json', forkItems);
        const ask = await forkCtx.send('Which codewords have I asked you to remember so far? Reply with the codewords only.');
        const answer = await settle(h, forkCtx, ask.turnId);
        const reply = replyText(answer.items, ask.turnId);
        report.data.forkReply = reply;
        expect(/APPLE/i.test(reply), `${provider} native fork remembers the first codeword`, reply.slice(-200));
        expect(!/PEAR/i.test(reply), `${provider} native fork forgets the later codeword`, reply.slice(-200));
        await ctx.shot('fork-answer', { widths: [1100, 420] });
      } else {
        note(`${provider} copy-fork composer draft: ${(await forkCtx.scope.locator('.chat-compose-shell textarea').inputValue()).slice(0, 120)}`);
      }
    } finally { await forked?.stop?.(); await ctx.stop(); }
  };
}

// Claude ExitPlanMode / Codex runtime plan card / Grok and Kimi plan exit.
function planScenario(provider, { setPlan, flow = 'full' } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live plan`, { dir });
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(setPlan)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const prompt = 'Make a short plan to add a `subtract(a, b)` function to src/math.js (and nothing else). Present the plan for my approval before changing any file.';
      const { turnId } = await ctx.send(prompt);
      const planCard = items => allParts(items).filter(part => part.type === 'approval' && part.data?.interaction === 'plan');
      const first = await settle(h, ctx, turnId, {
        stopWhen: items => planCard(items).some(part => part.status === 'pending'),
        onApproval: async part => { if (part.data?.interaction !== 'plan') await allowOnce(h, ctx, part); },
        timeout: 300_000,
      });
      await save(dir, 'items-plan1.json', first.items);
      const card = planCard(first.items).find(part => part.status === 'pending');
      report.data.planCard = card && { approvalId: card.approvalId, runtimeOwned: card.data?.runtimeOwned, requestType: card.data?.requestType, plan: card.data?.plan?.slice(0, 1500), choices: card.data?.choices };
      expect(Boolean(card), `${provider} shows a pending plan-approval card`, first.ended ? `ended ${first.ended}` : `no plan card; parts: ${allParts(first.items).map(part => part.type + (part.data?.interaction ? `/${part.data.interaction}` : '')).join(',')}`);
      if (!card) return;
      expect(!/subtract\s*\(/.test(readFile(join(ctx.cwd, 'src/math.js'))), `${provider} did not edit before approval`);
      await ctx.shot('plan-pending', { widths: [1100, 420] });
      await ctx.shot('plan-pending', { widths: [1100], theme: 'dark' });
      const cardLocator = ctx.scope.locator('.chat-plan-approval.pending');
      if (flow === 'abandon') {
        await cardLocator.locator('button', { hasText: 'Abandon' }).click();
        const done = await settle(h, ctx, turnId, { onApproval: async part => { if (part.data?.interaction !== 'plan') await allowOnce(h, ctx, part); } , timeout: 180_000 });
        await save(dir, 'items-abandon.json', done.items);
        const after = planCard(done.items).find(part => part.approvalId === card.approvalId);
        expect(after?.data?.planOutcome === 'abandoned', `${provider} card records the abandoned outcome`, after?.data ?? 'card gone');
        expect(!/subtract\s*\(/.test(readFile(join(ctx.cwd, 'src/math.js'))), `${provider} abandon leaves the file unchanged`);
        const ui = await h.request('chat.options', { sessionId: ctx.session.id });
        report.data.modeAfterAbandon = ui.options?.filter(option => ['mode', 'collaboration'].includes(option.id)).map(option => `${option.id}=${option.value}`);
        note(`${provider} mode after abandon: ${report.data.modeAfterAbandon}`);
        await ctx.shot('plan-abandoned', { widths: [1100] });
        return;
      }
      // Request changes, then approve the revised plan.
      await cardLocator.locator('button', { hasText: 'Request changes' }).click();
      let revisedTurn = turnId;
      if (card.data?.runtimeOwned) {
        await h.until(async () => (await ctx.scope.locator('.chat-plan-approval').innerText()).includes('Send your changes in the composer'), 'runtime-owned plan waits for the composer', 20_000);
        await ctx.shot('plan-request-changes-composer', { widths: [1100] });
        const sent = await ctx.send('Also add a `multiply(a, b)` function in the same plan.');
        revisedTurn = sent.turnId;
      } else {
        await cardLocator.locator('.chat-plan-feedback textarea').fill('Also add a `multiply(a, b)` function in the same plan.');
        await ctx.shot('plan-request-changes-feedback', { widths: [1100] });
        await cardLocator.locator('.chat-plan-feedback button', { hasText: 'Send' }).click();
      }
      await h.delay(8000);
      report.data.afterRequest = {
        error: await ctx.scope.locator('.surface-error').count() ? await ctx.scope.locator('.surface-error').first().innerText() : undefined,
        firstCard: planCard(await ctx.snapshot()).find(part => part.approvalId === card.approvalId)?.status,
        status: await ctx.status(),
      };
      note(`${provider} 8 s after Request changes: ${JSON.stringify(report.data.afterRequest)}`);
      let second;
      try {
        second = await settle(h, ctx, revisedTurn, {
          stopWhen: items => planCard(items).some(part => part.status === 'pending' && part.approvalId !== card.approvalId),
          onApproval: async part => { if (part.data?.interaction !== 'plan') await allowOnce(h, ctx, part); },
          timeout: 300_000,
        });
      } catch (error) {
        await save(dir, 'items-plan2-timeout.json', await ctx.snapshot());
        await ctx.shot('plan-revise-timeout', { widths: [1100] });
        throw error;
      }
      await save(dir, 'items-plan2.json', second.items);
      const oldCard = planCard(second.items).find(part => part.approvalId === card.approvalId);
      expect(oldCard?.data?.planOutcome === 'changes_requested', `${provider} first card records "changes requested"`, oldCard?.data?.planOutcome ?? oldCard?.status);
      const revised = planCard(second.items).find(part => part.status === 'pending' && part.approvalId !== card.approvalId);
      expect(Boolean(revised), `${provider} shows a revised pending plan card`, second.ended ?? 'none');
      if (!revised) return;
      expect(/multiply/i.test(revised.data?.plan ?? ''), `${provider} revised plan includes the requested change`, (revised.data?.plan ?? '').slice(0, 400));
      await ctx.shot('plan-revised', { widths: [1100] });
      await ctx.scope.locator('.chat-plan-approval.pending button', { hasText: 'Approve & build' }).click();
      const buildTurn = await h.until(async () => {
        const items = await ctx.snapshot();
        const turns = [...new Set(items.map(item => item.turnId).filter(Boolean))];
        return turns.at(-1);
      }, 'build turn id', 20_000);
      const built = await settle(h, ctx, buildTurn, { timeout: 360_000 });
      await h.delay(2000);
      const finalItems = await ctx.snapshot();
      await save(dir, 'items-built.json', finalItems);
      const source = readFile(join(ctx.cwd, 'src/math.js')) ?? '';
      expect(/subtract\s*\(/.test(source) && /multiply\s*\(/.test(source), `${provider} implemented the approved plan`, source.slice(0, 400));
      const approvedCard = planCard(finalItems).find(part => part.approvalId === revised.approvalId);
      expect(approvedCard?.data?.planOutcome === 'approved', `${provider} card records the approved outcome`, approvedCard?.data?.planOutcome ?? approvedCard?.status);
      const ui = await h.request('chat.options', { sessionId: ctx.session.id });
      report.data.modeAfterApprove = ui.options?.filter(option => ['mode', 'collaboration'].includes(option.id)).map(option => `${option.id}=${option.value}`);
      note(`${provider} mode after approve: ${report.data.modeAfterApprove}; approvals during build: ${JSON.stringify(built.approvals)}`);
      await ctx.shot('plan-built', { widths: [1100, 420] });
    } finally { await ctx.stop(); }
  };
}

// A real edit approval with a diff preview: allow once through the card, then deny a second edit.
function approvalScenario(provider, { options = {} } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live approval`, { dir });
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const first = await ctx.send('Edit src/greet.js so greet returns `Hi, ${name}!` instead of `Hello, ${name}!`. Use your file edit tool; do not use shell commands.');
      const isEdit = part => /"toolName":"(Edit|Write|MultiEdit|NotebookEdit)"|fileChange|"kind":"edit"|"diff"|apply_patch|"type":"edit"|permission.edit|"edit"/i.test(JSON.stringify(part.data?.details ?? part.data ?? {}));
      const editApproval = items => pendingApprovals(items).find(part => part.data?.interaction !== 'plan' && part.data?.interaction !== 'question' && isEdit(part));
      const otherApprovals = async (items) => { for (const part of pendingApprovals(items)) if (!isEdit(part) && part.data?.interaction !== 'question' && part.data?.interaction !== 'plan') { report.data.otherApprovals = [...(report.data.otherApprovals ?? []), part.data?.title ?? part.data?.requestType]; await allowOnce(h, ctx, part); } };
      const asked = await settle(h, ctx, first.turnId, { stopWhen: async items => { await otherApprovals(items); return editApproval(items); }, onApproval: async () => {}, timeout: 240_000 });
      await save(dir, 'items-ask1.json', asked.items);
      const part = editApproval(asked.items);
      expect(Boolean(part), `${provider} asks for approval before the edit`, asked.ended ?? `no approval; tools ${toolSummary(toolParts(asked.items))}`);
      if (!part) return;
      report.data.approval = { requestType: part.data?.requestType, title: part.data?.title, choices: part.data?.choices, previewUnavailableReason: part.data?.previewUnavailableReason, details: JSON.stringify(part.data?.details ?? null).slice(0, 1500) };
      const preview = await ctx.scope.locator('.chat-approval-card.pending .chat-approval-preview').count();
      expect(preview > 0, `${provider} approval card shows a diff preview`, part.data?.previewUnavailableReason ?? 'no preview element');
      await ctx.shot('approval-pending', { widths: [1100, 420] });
      await ctx.shot('approval-pending', { widths: [1100], theme: 'dark' });
      const chosen = await clickChoice(ctx, part, 'allow');
      note(`${provider} clicked ${chosen.label} (${chosen.scope})`);
      const done = await settle(h, ctx, first.turnId, { timeout: 240_000 });
      await save(dir, 'items-done1.json', done.items);
      expect(/Hi, \$\{name\}/.test(readFile(join(ctx.cwd, 'src/greet.js')) ?? ''), `${provider} applied the approved edit`, readFile(join(ctx.cwd, 'src/greet.js')));
      const resolved = allParts(done.items).find(row => row.approvalId === part.approvalId);
      expect(resolved?.status && resolved.status !== 'pending', `${provider} approval card resolves (${resolved?.status})`);
      // Deny a second edit.
      const second = await ctx.send('Now add the line `// edited by the agent` at the end of src/math.js using your file edit tool. If I deny the edit, just reply DENIED.');
      const asked2 = await settle(h, ctx, second.turnId, { stopWhen: async items => { await otherApprovals(items); return editApproval(items); }, onApproval: async () => {}, timeout: 240_000 });
      const part2 = editApproval(asked2.items);
      expect(Boolean(part2), `${provider} asks again for the second edit`, asked2.ended ?? 'no approval (a session-scoped allow may cover it)');
      if (part2) {
        await clickChoice(ctx, part2, 'deny');
        const denied = await settle(h, ctx, second.turnId, { timeout: 240_000, onApproval: async p => clickChoice(ctx, p, 'deny').catch(() => allowOnce(h, ctx, p)) });
        await save(dir, 'items-denied.json', denied.items);
        expect(!/edited by the agent/.test(readFile(join(ctx.cwd, 'src/math.js')) ?? ''), `${provider} denied edit left the file unchanged`);
        await ctx.shot('approval-denied', { widths: [1100] });
      }
    } finally { await ctx.stop(); }
  };
}

// E1 app-hosted tools: ask_user (a real question card answered through the UI) and session_info.
function askScenario(provider, { toolName, options = {} } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live ask`, { dir });
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const { turnId } = await ctx.send(`Use the ThreadTerm ${toolName('ask_user')} tool to ask me which colour I prefer, offering exactly two options: Red and Blue. After I answer, reply with my answer as one word.`);
      const question = items => pendingApprovals(items).find(part => part.data?.interaction === 'question');
      const asked = await settle(h, ctx, turnId, { stopWhen: items => question(items), timeout: 240_000 });
      await save(dir, 'items-ask.json', asked.items);
      const part = question(asked.items);
      report.data.question = part && { requestType: part.data?.requestType, form: part.data?.form, runtimeOwned: part.data?.runtimeOwned };
      expect(Boolean(part), `${provider} shows the ask_user question card`, asked.ended ?? `no question; tools ${toolSummary(toolParts(asked.items))}`);
      if (part) {
        await ctx.shot('ask-pending', { widths: [1100, 420] });
        const card = ctx.scope.locator('.chat-question-card').last();
        await card.locator('.chat-question-option', { hasText: 'Blue' }).click();
        await card.locator('button[type=submit]').click();
        const done = await settle(h, ctx, turnId, { timeout: 240_000 });
        await save(dir, 'items-answered.json', done.items);
        expect(/blue/i.test(replyText(done.items, turnId)), `${provider} reply uses the answer from the card`, replyText(done.items, turnId).slice(-200));
        await ctx.shot('ask-answered', { widths: [1100] });
      }
      const other = await h.request('session.create', { cwd: ctx.cwd, title: 'Referenced notes chat', provider: 'claude', mode: 'chat', operationId: randomUUID() });
      const info = await ctx.send(`Session ${other.id}: Referenced notes chat (claude). Call the ThreadTerm ${toolName('session_info')} tool with this id and tell me that session's title and provider, in one line.`);
      const infoDone = await settle(h, ctx, info.turnId, { timeout: 240_000 });
      await save(dir, 'items-info.json', infoDone.items);
      const infoTools = toolSummary(toolParts(turnItems(infoDone.items, info.turnId)));
      note(`${provider} session_info tools: ${infoTools.join(', ')}`);
      expect(infoTools.some(name => /session_info/.test(name)), `${provider} called session_info`, infoTools);
      expect(!toolParts(turnItems(infoDone.items, info.turnId)).some(part => /session_info/.test(part.toolName ?? '') && part.status === 'failed'), `${provider} session_info calls succeed`, infoTools);
      expect(/Referenced notes chat/i.test(replyText(infoDone.items, info.turnId)), `${provider} session_info reply names the referenced chat`, replyText(infoDone.items, info.turnId).slice(-300));
    } finally { await ctx.stop(); }
  };
}

function backgroundScenario(provider, { options = {}, prompt } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live background`, { dir });
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const { turnId } = await ctx.send(prompt);
      const result = await settle(h, ctx, turnId, { timeout: 240_000 });
      await save(dir, 'items.json', result.items);
      note(`${provider} tools: ${toolSummary(toolParts(turnItems(result.items, turnId))).join(', ')}`);
      const listed = await h.until(async () => { const { tasks } = await h.request('chat.backgroundTasks.list', { sessionId: ctx.session.id }); return tasks.length ? tasks : undefined; }, 'background task listed', 30_000).catch(() => []);
      report.data.tasks = listed;
      expect(listed.some(task => task.status === 'running'), `${provider} lists a running background task`, listed);
      await ctx.shot('background-running', { widths: [1100, 420] });
      const task = listed.find(row => row.status === 'running' && row.canStop) ?? listed.find(row => row.status === 'running');
      expect(listed.filter(row => row.status === 'running').length === 1, `${provider} lists the command once`, listed.map(row => `${row.id}:${row.canStop}`));
      if (task?.canStop) {
        const stopped = await h.request('chat.backgroundTask.stop', { sessionId: ctx.session.id, taskId: task.id, leaseEpoch: await ctx.lease(), operationId: randomUUID() });
        expect(stopped.accepted, `${provider} stop request accepted`, stopped);
        const after = await h.until(async () => { const { tasks } = await h.request('chat.backgroundTasks.list', { sessionId: ctx.session.id }); const row = tasks.find(candidate => candidate.id === task.id); return row && row.status !== 'running' ? tasks : undefined; }, 'background task stopped', 30_000).catch(() => undefined);
        report.data.tasksAfterStop = after;
        expect(Boolean(after), `${provider} background task leaves the running state after Stop`, after ?? 'still running');
        await ctx.shot('background-stopped', { widths: [1100] });
      } else if (task) note(`${provider} background task has no Stop (canStop=false)`);
    } finally { await ctx.stop(); }
  };
}

// E2/F3: providers without native steering take a note that the agent reads through feedback_check.
// A user types and presses Send as soon as a fresh chat's composer is writable. Only the real UI path: the
// harness never claims the lease, so any control or draft failure is the product's own.
function composeUiScenario(provider) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live compose ui`, { dir });
    try {
      const input = ctx.scope.locator('.chat-compose-shell textarea');
      const statuses = [];
      const track = async () => { const status = await ctx.status(); if (statuses.at(-1) !== status) statuses.push(status); };
      await h.until(async () => { await track(); return await input.count() && !(await input.isDisabled()); }, 'writable composer', 120_000, 100);
      const text = 'Reply with exactly the word READY and nothing else. Do not use any tools.';
      await input.fill(text);
      const errors = new Set();
      const start = Date.now();
      let submits = 0;
      const accepted = await h.until(async () => {
        await track();
        for (const row of await ctx.scope.locator('.surface-error, [role="alert"]').allInnerTexts()) if (row.trim()) errors.add(row.trim().slice(0, 160));
        if (!(await input.inputValue())) return true;
        submits += 1;
        await ctx.scope.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
        await h.delay(700);
        return !(await input.inputValue());
      }, 'composer accepted the message', 60_000, 100).catch(() => false);
      report.data.compose = { submits, acceptedAfterMs: accepted ? Date.now() - start : undefined, statuses, errors: [...errors] };
      note(`${provider} compose: ${JSON.stringify(report.data.compose)}`);
      expect(Boolean(accepted), `${provider} composer accepts a message typed as soon as it is writable`, report.data.compose);
      expect(errors.size === 0, `${provider} composer shows no control or draft error`, [...errors]);
      if (accepted) {
        const done = await h.until(async () => {
          const items = await ctx.snapshot();
          return items.some(item => item.role === 'assistant' && /READY/.test(textOf(item))) && items;
        }, 'READY reply', 180_000, 1500).catch(() => undefined);
        expect(Boolean(done), `${provider} answers the composed message`);
      }
      await ctx.shot('compose-ui', { widths: [1100] });
    } finally { await ctx.stop(); }
  };
}

function noteScenario(provider, { toolName, options = {} } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live note`, { dir });
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const { turnId } = await ctx.send(`Do these steps one at a time. Step 1: run this shell command and wait for it to finish: ${LONG_COMMAND}\nStep 2: run \`git status --short\`. Step 3: reply DONE. Before each step, check for user feedback with the ThreadTerm ${toolName('feedback_check')} tool and follow any feedback you receive.`);
      const running = await settle(h, ctx, turnId, { stopWhen: items => toolParts(turnItems(items, turnId)).some(part => /node -e|setTimeout/.test(JSON.stringify(part.data ?? '')) ), timeout: 240_000 });
      expect(Boolean(running.hit), `${provider} long command started before the note`, toolSummary(toolParts(running.items)));
      const ui = await h.request('chat.options', { sessionId: ctx.session.id });
      expect(ui.inputCapabilities?.steer === 'note', `${provider} offers notes instead of native steering (${ui.inputCapabilities?.steer})`);
      // The composer's Insert sends a note through chat.feedback.add for note-capable providers.
      const added = await h.request('chat.feedback.add', { sessionId: ctx.session.id, turnId, text: 'Also end your final reply with the word KIWI.', operationId: randomUUID(), leaseEpoch: await ctx.lease() });
      report.data.note = added.note;
      expect(added.note?.status === 'waiting', `${provider} note is waiting (${added.note?.status})`);
      await ctx.shot('note-waiting', { widths: [1100, 420] });
      const result = await settle(h, ctx, turnId, { timeout: 360_000 });
      await save(dir, 'items.json', result.items);
      const { notes } = await h.request('chat.feedback.read', { sessionId: ctx.session.id });
      report.data.notes = notes;
      const tools = toolSummary(toolParts(turnItems(result.items, turnId)));
      note(`${provider} tools: ${tools.join(', ')}`);
      expect(tools.some(name => /feedback_check/.test(name)), `${provider} called feedback_check`, tools);
      expect(notes.length === 0 || notes.every(row => row.status === 'received'), `${provider} note is marked received`, notes);
      expect(/KIWI/.test(replyText(result.items, turnId)), `${provider} reply follows the note (KIWI)`, replyText(result.items, turnId).slice(-300));
      await ctx.shot('note-done', { widths: [1100] });
    } finally { await ctx.stop(); }
  };
}

// G1 generated UI (opt-in) plus Mermaid and KaTeX from a real reply; with the switch off, no format instruction.
function generatedUiScenario(provider, { options = {} } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    await h.setSettings({ chatTools: { generatedUi: true } });
    const on = await h.openChat(provider, `${provider} live generated UI`, { dir });
    try {
      await on.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, on, id, value)}`);
      const { turnId } = await on.send('Without using any tools, answer from this description: the repo has README.md, src/math.js (5 lines) and src/greet.js (2 lines), and two TODO comments ("add a subtract function", "support a custom greeting"). '
        + 'Give a compact visual answer using ThreadTerm generated UI: one card titled "Parity sandbox" with a stat for the 2 source files, a list of the two TODOs, and a bar chart of line counts per file. '
        + 'After it, add a Mermaid flowchart (```mermaid) of a function add(a, b) returning a + b, and a display formula $$a + b = c$$.');
      const result = await settle(h, on, turnId, { timeout: 300_000 });
      await save(dir, 'items-on.json', result.items);
      const reply = replyText(result.items, turnId);
      expect(/```threadterm-ui/.test(reply), `${provider} emits a threadterm-ui block when generated UI is on`, reply.slice(0, 300));
      const ui = on.scope.locator('[data-testid="generated-ui"]');
      expect(await ui.count() > 0 && await on.scope.locator('[data-testid="generated-ui"] .markdown-extra-error').count() === 0, `${provider} generated UI renders without a format error`, await ui.count() ? await ui.first().innerText() : 'none');
      expect(await on.scope.locator('[data-testid="markdown-mermaid"] svg').count() > 0, `${provider} Mermaid block renders an SVG`, await on.scope.locator('[data-testid="markdown-mermaid"]').count() ? (await on.scope.locator('[data-testid="markdown-mermaid"]').first().innerText()).slice(0, 200) : 'no mermaid block');
      expect(await on.scope.locator('[data-testid="markdown-math"] .katex, .katex').count() > 0, `${provider} KaTeX formula renders`);
      await on.shot('generated-ui', { widths: [1100, 420] });
      await on.shot('generated-ui', { widths: [1100], theme: 'dark' });
    } finally { await on.stop(); }
    await h.setSettings({ chatTools: { generatedUi: false } });
    const off = await h.openChat(provider, `${provider} live generated UI off`, { dir });
    try {
      await off.connect();
      const { turnId } = await off.send('Do your instructions or tool descriptions mention a block format named threadterm-ui? Answer only YES or NO. Do not use any tools.');
      const result = await settle(h, off, turnId, { timeout: 180_000 });
      const reply = replyText(result.items, turnId).trim();
      report.data.offReply = reply;
      expect(/\bNO\b/i.test(reply) && !/\bYES\b/i.test(reply), `${provider} has no generated-UI instruction when the switch is off`, reply.slice(0, 200));
    } finally { await off.stop(); }
  };
}

// E3: picking an agent from the @ menu makes the parent delegate through delegate_start.
function mentionScenario(provider, { agent, options = {} } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live mention`, { dir });
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const composer = ctx.scope.locator('.chat-compose-shell textarea');
      const popup = ctx.scope.locator('.chat-mentions');
      await composer.fill('@');
      await popup.waitFor();
      const row = popup.locator('[data-testid="mention-option"][data-mention-group="agents"]', { hasText: new RegExp(agent, 'i') }).first();
      await row.waitFor({ timeout: 20_000 });
      await row.click();
      await h.until(async () => (await ctx.scope.locator('[data-testid="context-tray"] [data-testid="context-chip"]').count()) > 0, 'agent chip', 10_000);
      await composer.fill('Ask the delegate to reply with the single word PONG and nothing else, wait for its result, then tell me exactly what it replied.');
      await ctx.shot('mention-chip', { widths: [1100, 420] });
      await ctx.scope.locator('.chat-compose-send[aria-label="Send"]').click();
      const turnId = await h.until(async () => (await ctx.snapshot()).filter(item => item.role === 'user').at(-1)?.turnId, 'mention turn', 20_000);
      const serialized = (await ctx.snapshot()).filter(item => item.role === 'user').at(-1)?.parts?.map(part => part.text).join('');
      report.data.serialized = serialized;
      expect(/delegate_start/.test(serialized ?? ''), `${provider} mention serializes a delegate_start instruction`, (serialized ?? '').slice(0, 300));
      const result = await settle(h, ctx, turnId, { timeout: 480_000 });
      await save(dir, 'items.json', result.items);
      const sessions = (await h.request('runtime.snapshot')).sessions.filter(row => row.delegation?.parentSessionId === ctx.session.id);
      report.data.delegates = sessions.map(row => ({ id: row.id, provider: row.provider, state: row.delegation?.state, status: row.status }));
      expect(sessions.some(row => new RegExp(agent, 'i').test(row.provider)), `${provider} started a ${agent} delegate`, report.data.delegates);
      expect(/PONG/.test(replyText(result.items, turnId)), `${provider} relays the delegate's reply`, replyText(result.items, turnId).slice(-300));
      note(`${provider} tools: ${toolSummary(toolParts(turnItems(result.items, turnId))).join(', ')}`);
      await ctx.shot('mention-done', { widths: [1100] });
    } finally { await ctx.stop(); }
  };
}

// Cheap questions about what an agent actually received: the G1 instruction and its todo tools.
function instructionsScenario(provider, { mcpPrefix, options = {} } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    await h.setSettings({ chatTools: { generatedUi: true } });
    const ctx = await h.openChat(provider, `${provider} live instructions`, { dir });
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const ask = async text => { const { turnId } = await ctx.send(text); const result = await settle(h, ctx, turnId, { timeout: 180_000 }); return replyText(result.items, turnId).trim(); };
      report.data.g1 = await ask('Do your instructions, MCP server instructions or tool descriptions mention a block format named threadterm-ui? Answer YES or NO, then quote the sentence that mentions it if YES. Do not use any tools.');
      expect(/\bYES\b/.test(report.data.g1), `${provider} received the generated-UI instruction with the switch on`, report.data.g1.slice(0, 300));
      report.data.todo = await ask('List the exact names of the tools you have for keeping a todo list, task list or plan. Names only, comma separated. Do not use any tools.');
      note(`${provider} todo tools: ${report.data.todo.slice(0, 200)}`);
      if (mcpPrefix) {
        report.data.mcp = await ask(`List the exact names of every tool you have whose name starts with ${mcpPrefix}. Names only, comma separated. Do not use any tools.`);
        note(`${provider} threadterm tools: ${report.data.mcp.slice(0, 300)}`);
      }
    } finally { await ctx.stop(); await h.setSettings({ chatTools: { generatedUi: false } }); }
  };
}

// F1: a file @mention typed and picked through the real composer, sent through the real send button, so the
// stored envelope carries the context block and the `mentions v1` map and the sent bubble paints the badge.
function inlineMentionScenario(provider, { options = {} } = {}) {
  return async (h) => {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat(provider, `${provider} live inline mention`, { dir });
    try {
      await ctx.connect();
      for (const [id, value] of Object.entries(options)) note(`${provider} option ${id} -> ${await setOption(h, ctx, id, value)}`);
      const composer = ctx.scope.locator('.chat-compose-shell textarea');
      const popup = ctx.scope.locator('.chat-mentions');
      await composer.click();
      await composer.fill('What is the magic number in @READ');
      await popup.waitFor();
      const row = popup.locator('[data-testid="mention-option"][data-mention-group="files"]', { hasText: 'README.md' }).first();
      await row.waitFor({ timeout: 20_000 });
      await row.click();
      await h.until(async () => (await composer.inputValue()).includes('@README.md'), 'README token inserted', 10_000);
      const afterPick = await composer.inputValue();
      report.data.afterPick = afterPick;
      expect(/@README\.md/.test(afterPick), `${provider} picking README.md keeps the token in the sentence`, afterPick);
      expect(await ctx.scope.locator('[data-testid="context-tray"] [data-testid="context-chip"]').count() === 0, `${provider} the mention adds no tray chip`);
      const badgeBefore = await ctx.scope.locator('.chat-compose-highlights .chat-mention-badge').count();
      expect(badgeBefore >= 1, `${provider} composer highlights the token as a badge`, badgeBefore);
      await ctx.shot('inline-mention-composed', { widths: [1100, 420] });
      await composer.focus();
      await composer.evaluate(node => node.setSelectionRange(node.value.length, node.value.length));
      await ctx.page.keyboard.type('? Answer with the number only.');
      const full = await composer.inputValue();
      report.data.composerText = full;
      expect(/^What is the magic number in @README\.md \? Answer with the number only\.$/.test(full), `${provider} composer holds the final sentence`, full);
      await ctx.scope.locator('.chat-compose-send[aria-label="Send"]').click();
      const turnId = await h.until(async () => (await ctx.snapshot()).filter(item => item.role === 'user').at(-1)?.turnId, 'inline-mention turn', 20_000);
      const userItem = (await ctx.snapshot()).filter(item => item.role === 'user').at(-1);
      const userText = (userItem?.parts ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
      report.data.userText = userText;
      expect(/\[ThreadTerm message; mentions v1/.test(userText), `${provider} stored user text carries the mentions v1 header`, userText.slice(0, 400));
      expect(/File: README\.md/.test(userText), `${provider} stored user text carries the README item header`, userText.slice(0, 400));
      const result = await settle(h, ctx, turnId, { timeout: 300_000 });
      await save(dir, 'items.json', result.items);
      const reply = replyText(result.items, turnId);
      report.data.reply = reply;
      expect(!result.ended, `${provider} inline-mention turn ended normally`, result.ended);
      expect(/4817/.test(reply), `${provider} answer names the magic number`, reply.slice(-300));
      const bubble = ctx.scope.locator('.v3-chat-message.user').last();
      await h.until(async () => (await bubble.locator('.chat-mention-badge').count()) >= 1, 'sent bubble badge', 15_000);
      const badgeText = await bubble.locator('.chat-mention-badge').first().innerText();
      report.data.badgeText = badgeText;
      expect(/@README\.md/.test(badgeText), `${provider} sent user bubble shows the inline README badge`, badgeText);
      expect(await bubble.locator('[data-testid="context-chip"]').count() === 0, `${provider} the badged item is not repeated as a chip`);
      await ctx.shot('inline-mention-sent', { widths: [1100, 420] });
      await ctx.shot('inline-mention-sent', { widths: [1100], theme: 'dark' });
    } finally { await ctx.stop(); }
  };
}

const claudeTool = name => `mcp__threadterm__${name}`;
// The user's default Pi model has an invalid DeepSeek key; pick the working command provider for this session only
// (Pi's RPC set_model does not persist a default).
const PI_MODEL = { model: 'command\u001fdeepseek/deepseek-v4.1-flash' };
const codexTool = name => `threadterm ${name}`;
const grokTool = name => `threadterm__${name}`;

export const scenarios = {
  // Connects every live provider and records its options, capabilities and connection state. No model turn.
  async probe({ request, openChat, dir, report, pass, fail, note, delay, until }) {
    // Provider discovery is asynchronous after a cold start; the list fills in once the probes answer.
    const providers = await until(async () => {
      const list = await request('provider.list');
      return LIVE_PROVIDERS.every(id => list.some(row => row.id === id)) && list;
    }, 'provider discovery', 120_000, 1000);
    report.data.providers = providers.map(row => ({ id: row.id, chat: row.chat, auth: row.auth, version: row.version, installed: row.installed }));
    for (const provider of LIVE_PROVIDERS) {
      const row = providers.find(candidate => candidate.id === provider);
      if (!row?.chat) { fail(`${provider} is not a chat provider here`); continue; }
      const ctx = await openChat(provider, `${provider} probe`, { dir });
      try {
        const connection = await ctx.connect();
        pass(`${provider} connected (native ${connection.nativeId ?? 'none yet'})`);
        let ui = await request('chat.options', { sessionId: ctx.session.id });
        for (let i = 0; i < 20 && ui.loadState === 'loading'; i += 1) { await delay(1000); ui = await request('chat.options', { sessionId: ctx.session.id }); }
        report.data[provider] = { connection, ui: summarizeOptions(ui), context: await request('chat.context.read', { sessionId: ctx.session.id }) };
        note(`${provider} options: ${(ui.options ?? []).map(option => `${option.id}=${option.value}[${option.choices?.map(choice => choice.value).slice(0, 8).join('|')}]`).join('; ')}`);
        note(`${provider} steer=${ui.inputCapabilities?.steer ?? 'none'} images=${ui.inputCapabilities?.images ?? 'unset'} commands=${ui.commands?.length ?? 0} skills=${ui.skills?.length ?? 'absent'}`);
        await ctx.shot(`${provider}-connected`, { widths: [1100, 420] });
      } catch (error) {
        fail(`${provider} probe: ${error.message}`);
      } finally {
        await ctx.stop();
      }
    }
    await save(dir, 'probe.json', report.data);
  },

  // Option changes on a fresh session, before any model turn (what a user does with the composer chips).
  async 'claude:options'(h) {
    const { note, expect, report, dir } = h;
    const ctx = await h.openChat('claude', 'claude live options', { dir });
    try {
      await ctx.connect();
      report.data.steps = [];
      for (const [id, value, wait] of [['mode', 'acceptEdits', Number(process.env.LIVE_OPTIONS_WAIT ?? 0)], ['model', 'sonnet', 0], ['mode', 'plan', 0], ['thinking', 'low', 0], ['mode', 'default', 0]]) {
        if (wait) await h.delay(wait);
        const started = Date.now();
        try {
          const applied = await setOption(h, ctx, id, value);
          report.data.steps.push({ id, value, applied, ms: Date.now() - started });
          expect(applied === value, `claude ${id}=${value} applied in ${Date.now() - started} ms`, { applied });
        } catch (error) {
          report.data.steps.push({ id, value, error: error.message, ms: Date.now() - started });
          expect(false, `claude ${id}=${value} before the first turn`, error.message.replace(/^.*RuntimeRequestError: /, ''));
        }
      }
      const { turnId } = await ctx.send('Reply with exactly OPTIONS-OK and nothing else. Do not use any tools.');
      const result = await settle(h, ctx, turnId, { timeout: 180_000 });
      expect(/OPTIONS-OK/.test(replyText(result.items, turnId)), 'claude answers after the option changes', replyText(result.items, turnId).slice(-200));
      for (const [id, value] of [['mode', 'acceptEdits'], ['mode', 'default']]) {
        const started = Date.now();
        try { expect(await setOption(h, ctx, id, value) === value, `claude ${id}=${value} after a turn in ${Date.now() - started} ms`); }
        catch (error) { expect(false, `claude ${id}=${value} after a turn`, error.message.replace(/^.*RuntimeRequestError: /, '')); }
      }
      note(`claude option timings: ${JSON.stringify(report.data.steps)}`);
    } finally { await ctx.stop(); }
  },
  'claude:turn': turnScenario('claude', { options: { mode: 'acceptEdits' } }),
  'claude:steer': steerScenario('claude', { options: { mode: 'acceptEdits' } }),
  // D4 carry: a steer sent into a short, tool-free turn usually misses it and runs as its own carry turn.
  async 'claude:steer-carry'(h) {
    const { expect, note, report, dir } = h;
    const ctx = await h.openChat('claude', 'claude live steer carry', { dir });
    try {
      await ctx.connect();
      const { turnId } = await ctx.send('Reply with exactly the word ALPHA and nothing else. Do not use any tools.');
      await h.until(async () => (await ctx.status()) === 'running', 'turn running', 30_000, 100);
      const steer = await ctx.steer(turnId, 'Now reply with exactly the word BETA and nothing else.');
      report.data.steer = steer;
      expect(['delivered', 'queued'].includes(steer.disposition), `claude carry steer accepted (${steer.disposition})`);
      const done = await h.until(async () => {
        const items = await ctx.snapshot();
        const text = items.filter(item => item.role === 'assistant').map(textOf).join('\n');
        return (await ctx.status()) === 'idle' && /BETA/.test(text) && items;
      }, 'both replies and idle', 240_000, 1500).catch(() => undefined);
      const items = done ?? await ctx.snapshot();
      await save(dir, 'items.json', items);
      const turns = [...new Set(items.map(item => item.turnId).filter(Boolean))];
      report.data.turns = turns;
      report.data.replies = items.filter(item => item.role === 'assistant').map(item => `${item.turnId}: ${textOf(item).slice(0, 60)}`);
      note(`claude carry turns: ${turns.join(', ')}; replies ${JSON.stringify(report.data.replies)}`);
      expect(Boolean(done), 'claude answers ALPHA and the steered BETA, then settles idle', report.data.replies);
      const steered = items.find(item => item.role === 'user' && item.parts.some(part => part.data?.steered === true));
      const betaTurn = items.find(item => item.role === 'assistant' && /BETA/.test(textOf(item)))?.turnId;
      expect(Boolean(steered) && steered.turnId === betaTurn, 'the steered row sits in the turn that answered it', { steered: steered?.turnId, betaTurn });
      const follow = await ctx.send('Reply with exactly the word GAMMA and nothing else.');
      const after = await settle(h, ctx, follow.turnId, { timeout: 180_000 });
      expect(/GAMMA/.test(replyText(after.items, follow.turnId)) && !/BETA/.test(replyText(after.items, follow.turnId)), 'the next message gets its own reply', replyText(after.items, follow.turnId).slice(-120));
      await ctx.shot('steer-carry', { widths: [1100] });
    } finally { await ctx.stop(); }
  },
  'claude:fork': forkScenario('claude'),
  'claude:plan': planScenario('claude', { setPlan: { mode: 'plan' } }),
  'claude:plan-abandon': planScenario('claude', { setPlan: { mode: 'plan' }, flow: 'abandon' }),
  'claude:approval': approvalScenario('claude', { options: { mode: 'default' } }),
  'claude:ask': askScenario('claude', { toolName: claudeTool, options: { mode: 'acceptEdits' } }),
  'claude:background': backgroundScenario('claude', { options: { mode: 'acceptEdits' }, prompt: 'Start this command as a background Bash task (run_in_background: true) and do not wait for it: node -e "setInterval(() => {}, 1000)"\nThen reply with the single word STARTED.' }),

  'codex:turn': turnScenario('codex', { options: {} }),
  'codex:steer': steerScenario('codex', { options: {} }),
  'codex:fork': forkScenario('codex'),
  'codex:plan': planScenario('codex', { setPlan: { collaboration: 'plan' } }),
  'codex:plan-abandon': planScenario('codex', { setPlan: { collaboration: 'plan' }, flow: 'abandon' }),
  'codex:approval': approvalScenario('codex'),
  'codex:ask': askScenario('codex', { toolName: codexTool, options: {} }),
  'codex:background': backgroundScenario('codex', { options: {}, prompt: 'Start this long-running command in a background terminal so it keeps running after your turn, and do not wait for it: node -e "setInterval(() => {}, 1000)"\nThen reply with the single word STARTED.' }),

  'pi:turn': turnScenario('pi', { planExpected: false, options: PI_MODEL }),
  'pi:steer': steerScenario('pi', { options: PI_MODEL }),
  'pi:fork': forkScenario('pi', { options: PI_MODEL }),

  'opencode:turn': turnScenario('opencode'),
  'opencode:fork': forkScenario('opencode'),

  'grok:turn': turnScenario('grok', { options: { mode: 'acceptEdits' }, windowExpected: false }),
  'grok:plan': planScenario('grok', { setPlan: { mode: 'plan' } }),
  'grok:plan-abandon': planScenario('grok', { setPlan: { mode: 'plan' }, flow: 'abandon' }),
  'grok:approval': approvalScenario('grok', { options: { mode: 'default' } }),
  'grok:ask': askScenario('grok', { toolName: grokTool, options: { mode: 'acceptEdits' } }),
  'grok:fork': forkScenario('grok', { expectMode: 'copy' }),

  'kimi:turn': turnScenario('kimi', { windowExpected: false }),
  'kimi:plan': planScenario('kimi', { setPlan: { mode: 'plan' } }),
  'kimi:plan-abandon': planScenario('kimi', { setPlan: { mode: 'plan' }, flow: 'abandon' }),
  'kimi:approval': approvalScenario('kimi', { options: { mode: 'default' } }),
  'kimi:ask': askScenario('kimi', { toolName: claudeTool }),
  'kimi:fork': forkScenario('kimi'),

  'grok:note': noteScenario('grok', { toolName: grokTool, options: { mode: 'acceptEdits' } }),
  'kimi:note': noteScenario('kimi', { toolName: claudeTool }),
  'claude:compose-ui': composeUiScenario('claude'),
  'codex:compose-ui': composeUiScenario('codex'),
  'claude:generated-ui': generatedUiScenario('claude'),
  'codex:generated-ui': generatedUiScenario('codex'),
  'grok:generated-ui': generatedUiScenario('grok', { options: { mode: 'acceptEdits' } }),
  'claude:mention': mentionScenario('claude', { agent: 'codex', options: { mode: 'acceptEdits' } }),
  'claude:inline-mention': inlineMentionScenario('claude', { options: { mode: 'acceptEdits' } }),
  'codex:inline-mention': inlineMentionScenario('codex'),

  // D3 + E3: a protected Pi skill loads only after ThreadTerm trusts the project, then shows as a skill.
  async 'pi:trust'(h) {
    const { expect, note, report, dir } = h;
    const workspace = await h.makeWorkspace(`pi-trust-${randomUUID().slice(0, 8)}`);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(workspace, '.pi/skills/parity-skill'), { recursive: true });
    writeFileSync(join(workspace, '.pi/skills/parity-skill/SKILL.md'), '---\nname: parity-skill\ndescription: ThreadTerm parity probe skill. Use only when the user invokes it.\n---\nWhen this skill runs, reply with exactly PARITY-SKILL-OK and nothing else. Do not use any tools.\n');
    const ctx = await h.openChat('pi', 'pi live trust', { workspace, dir });
    try {
      await ctx.connect();
      let ui = await h.request('chat.options', { sessionId: ctx.session.id });
      report.data.before = { piTrust: ui.piTrust, skills: ui.skills };
      expect((ui.piTrust?.protectedResources ?? []).some(path => /skills/.test(path)), 'pi lists the protected .pi/skills resource', ui.piTrust ?? 'no piTrust');
      expect(ui.piTrust?.effective === 'skipped', `pi skips protected resources before trust (${ui.piTrust?.effective})`);
      expect(!(ui.skills ?? []).some(skill => skill.name.includes('parity-skill')), 'pi does not offer the untrusted skill');
      await ctx.shot('trust-untrusted', { widths: [1100, 420] });
      ui = await h.request('chat.projectTrust.set', { sessionId: ctx.session.id, decision: 'trusted', leaseEpoch: await ctx.lease(), operationId: randomUUID() });
      await ctx.connect();
      ui = await h.until(async () => { const next = await h.request('chat.options', { sessionId: ctx.session.id }); return next.piTrust?.effective === 'loaded' && next; }, 'pi trusted and reloaded', 90_000).catch(async () => h.request('chat.options', { sessionId: ctx.session.id }));
      report.data.after = { piTrust: ui.piTrust, skills: ui.skills };
      expect(ui.piTrust?.effective === 'loaded', `pi loads protected resources after trust (${ui.piTrust?.effective})`);
      const skill = (ui.skills ?? []).find(row => row.name.includes('parity-skill'));
      expect(Boolean(skill), 'pi publishes the trusted project skill', ui.skills ?? 'skills absent');
      await ctx.shot('trust-trusted', { widths: [1100] });
      if (skill) {
        note(`pi model for the skill turn -> ${await setOption(h, ctx, 'model', PI_MODEL.model)}`);
        const { turnId } = await ctx.send(skill.invocation);
        const result = await settle(h, ctx, turnId, { timeout: 240_000 });
        await save(dir, 'items-skill.json', result.items);
        expect(/PARITY-SKILL-OK/.test(replyText(result.items, turnId)), `pi runs the skill through ${skill.invocation}`, replyText(result.items, turnId).slice(-200));
      }
      ui = await h.request('chat.projectTrust.set', { sessionId: ctx.session.id, decision: 'declined', leaseEpoch: await ctx.lease(), operationId: randomUUID() });
      await ctx.connect();
      ui = await h.until(async () => { const next = await h.request('chat.options', { sessionId: ctx.session.id }); return next.piTrust?.effective === 'skipped' && next; }, 'pi declined', 90_000).catch(async () => h.request('chat.options', { sessionId: ctx.session.id }));
      expect(ui.piTrust?.effective === 'skipped' && !(ui.skills ?? []).some(row => row.name.includes('parity-skill')), 'pi skips the skill again after Decline', ui.piTrust);
      note(`pi trust decisions: ${JSON.stringify({ before: report.data.before.piTrust, after: report.data.after.piTrust })}`);
    } finally { await ctx.stop(); }
  },

  'claude:instructions': instructionsScenario('claude', { mcpPrefix: 'mcp__threadterm__' }),
  'codex:instructions': instructionsScenario('codex'),
  'grok:instructions': instructionsScenario('grok', { options: { mode: 'acceptEdits' } }),
  'kimi:instructions': instructionsScenario('kimi'),
  'opencode:instructions': instructionsScenario('opencode'),

  async 'codex:fast'(h) {
    const { expect, report, dir } = h;
    const ctx = await h.openChat('codex', 'codex live fast', { dir });
    try {
      await ctx.connect();
      expect(await setOption(h, ctx, 'fast', 'true') === 'true', 'codex Fast turns on');
      const { turnId } = await ctx.send('Reply with exactly FAST-OK and nothing else. Do not use any tools.');
      const result = await settle(h, ctx, turnId, { timeout: 180_000 });
      expect(/FAST-OK/.test(replyText(result.items, turnId)), 'codex answers with Fast on', replyText(result.items, turnId).slice(-200));
      const ui = await h.request('chat.options', { sessionId: ctx.session.id });
      report.data.fastAfterTurn = ui.options.find(option => option.id === 'fast')?.value;
      expect(report.data.fastAfterTurn === 'true', `codex Fast stays on after the turn (${report.data.fastAfterTurn})`);
      await ctx.shot('fast-on', { widths: [1100, 420] });
      expect(await setOption(h, ctx, 'fast', 'false') === 'false', 'codex Fast turns off');
      expect(await setOption(h, ctx, 'fast', 'false') === 'false', 'codex re-selecting the current value is a no-op');
    } finally { await ctx.stop(); }
  },
};
export { LIVE_PROVIDERS, textOf, replyText, turnItems, allParts, toolParts, pendingApprovals, settle, setOption, allowOnce, clickChoice, save, readFile };
