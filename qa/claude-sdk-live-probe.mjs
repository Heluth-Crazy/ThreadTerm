// Claude Agent SDK capability probe for Claude Chat (task 09-29-agent-compat-claude).
// Drives the SDK exactly like providers/claude-sdk/src/session.mjs (streaming input,
// bundled CLI, settingSources user/project/local) inside a temporary workspace that
// holds one project command, one project skill and a tiny script.
//
//   node qa/claude-sdk-live-probe.mjs        zero-cost: initializationResult + summary
//                                            context usage (no model turn)
//   THREADTERM_QA_CLAUDE_LIVE=commands,options,approvals node qa/claude-sdk-live-probe.mjs
//                                            + short real model turns per suite (billable /
//                                              uses the local Claude login); `all` = every suite
//
// Uses the caller's normal Claude configuration (~/.claude). The account email and
// organization are never printed. Permission suggestions are applied only when their
// destination is the session or the temporary project, never user settings. The probe's
// own session history under ~/.claude/projects is removed afterwards.
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { createInputQueue } from '../providers/claude-sdk/src/session.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requested = (process.env.THREADTERM_QA_CLAUDE_LIVE ?? '').split(',').map(value => value.trim()).filter(Boolean);
const suites = new Set(requested.includes('all') ? ['commands', 'options', 'approvals'] : requested);
const bundledCli = join(root, 'providers/claude-sdk/dist', `claude-sdk-cli${process.platform === 'win32' ? '.exe' : ''}`);
const workspace = await mkdtemp(join(tmpdir(), 'tt-claude-probe-'));
const MARK = { cmd: 'TT-CMD-EXPANDED-7731', skill: 'TT-SKILL-EXPANDED-5190' };
await mkdir(join(workspace, '.claude/commands'), { recursive: true });
await mkdir(join(workspace, '.claude/skills/tt-probe-skill'), { recursive: true });
await writeFile(join(workspace, '.claude/commands/tt-probe-cmd.md'),
  `---\ndescription: ThreadTerm probe command\n---\nReply with exactly ${MARK.cmd} and nothing else. Do not use any tools.\n`);
await writeFile(join(workspace, '.claude/skills/tt-probe-skill/SKILL.md'),
  `---\nname: tt-probe-skill\ndescription: ThreadTerm probe skill. Use only when the user invokes /tt-probe-skill.\n---\nWhen this skill runs, reply with exactly ${MARK.skill} and nothing else. Do not use any tools.\n`);
await writeFile(join(workspace, 'tt.js'), 'console.log(42);\n');

// The real runtime is started from the desktop environment, not from inside a
// Claude Code session; drop this session's nesting markers.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CLAUDECODE|CLAUDE_CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|EXECPATH)|CLAUDE_PID|CLAUDE_EFFORT)/.test(key)));
const BROWSER_OPENING = new Set(['/extra-usage', '/usage-credits', '/login', '/logout', '/feedback', '/bug']);

const report = { suites: [...suites], workspace: basename(workspace), cliExists: existsSync(bundledCli), permissionCalls: [], stopHooks: [], turns: [] };
// Per tool: 'deny' | 'once' | 'always'. Skill and Read are always allowed.
const answers = new Map();
const canUseTool = async (toolName, input, { suggestions } = {}) => {
  const call = { turn: report.turns.length, toolName, input: JSON.stringify(input).slice(0, 160), suggestions: suggestions ?? null };
  report.permissionCalls.push(call);
  const answer = toolName === 'Skill' || toolName === 'Read' ? 'once' : answers.get(toolName) ?? answers.get('*') ?? 'deny';
  if (answer === 'deny') return { behavior: 'deny', message: 'probe denies this tool' };
  const safe = (suggestions ?? []).filter(update => ['session', 'localSettings', 'projectSettings'].includes(update.destination));
  call.answered = answer === 'always' ? { updatedPermissions: safe } : 'once';
  return { behavior: 'allow', updatedInput: input, ...(answer === 'always' && safe.length ? { updatedPermissions: safe } : {}) };
};
const stopHook = async hookInput => { report.stopHooks.push({ turn: report.turns.length, effort: hookInput.effort ?? null, permissionMode: hookInput.permission_mode ?? null }); return {}; };

const input = createInputQueue();
const query = sdk.query({ prompt: input, options: {
  cwd: workspace, env, settingSources: ['user', 'project', 'local'], includePartialMessages: false,
  pathToClaudeCodeExecutable: bundledCli, canUseTool, hooks: { Stop: [{ hooks: [stopHook] }] },
} });
const iterator = query[Symbol.asyncIterator]();

async function turn(label, text, timeoutMs = 180000) {
  if (BROWSER_OPENING.has(text.trim().split(/\s+/)[0])) throw new Error(`${text} can open the user's browser; the probe never sends it`);
  input.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
  const summary = { label, sent: text, system: [], assistantText: '', models: [], tools: [], result: null, ...(suites.has('local') ? { raw: [] } : {}) };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const next = await Promise.race([iterator.next(), new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(1, deadline - Date.now())))]);
    if (next.done) { summary.result = 'query ended'; break; }
    const message = next.value;
    if (summary.raw) summary.raw.push({ type: message.type, subtype: message.subtype, sessionId: message.session_id, isReplay: message.isReplay, isSynthetic: message.isSynthetic, content: typeof message.content === 'string' ? message.content.slice(0, 240) : typeof message.message?.content === 'string' ? message.message.content.slice(0, 240) : undefined, status: message.status, permissionMode: message.permissionMode, compactResult: message.compact_result });
    if (message.type === 'system') {
      const entry = { subtype: message.subtype };
      if (message.subtype === 'init') Object.assign(entry, { model: message.model, permissionMode: message.permissionMode, apiKeySource: message.apiKeySource, version: message.claude_code_version, slashCommands: message.slash_commands?.length, terminalOnly: message.terminal_slash_commands });
      if (message.subtype === 'compact_boundary') entry.compact = { trigger: message.compact_metadata?.trigger, pre: message.compact_metadata?.pre_tokens, post: message.compact_metadata?.post_tokens };
      if (message.subtype === 'commands_changed') entry.commands = message.commands?.map(command => command.name);
      if (message.subtype === 'status') entry.status = message.status ?? null;
      summary.system.push(entry);
    } else if (message.type === 'assistant') {
      if (message.message?.model) summary.models.push(message.message.model);
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text') summary.assistantText += block.text;
        if (block.type === 'tool_use') summary.tools.push(block.name);
      }
    } else if (message.type === 'user' && typeof message.message?.content === 'string') {
      summary.localOutput = (summary.localOutput ?? '') + message.message.content.slice(0, 300);
    } else if (message.type === 'result') {
      summary.result = { subtype: message.subtype, isError: message.is_error, text: String(message.result ?? '').slice(0, 200), turns: message.num_turns, modelUsage: Object.keys(message.modelUsage ?? {}), costUsd: message.total_cost_usd };
      break;
    }
  }
  report.turns.push(summary);
  return summary;
}
const contextModel = async () => (await query.getContextUsage({ detail: 'summary' })).model;

try {
  const init = await query.initializationResult();
  const names = init.commands.map(command => command.name);
  report.init = {
    commandCount: names.length,
    commands: init.commands.map(command => `${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}${command.aliases?.length ? ` (aliases ${command.aliases.join(',')})` : ''} :: ${String(command.description).slice(0, 70)}`),
    hasCompact: names.includes('compact'), hasProbeCommand: names.includes('tt-probe-cmd'), hasProbeSkill: names.includes('tt-probe-skill'),
    models: init.models.map(model => ({ value: model.value, displayName: model.displayName, resolvedModel: model.resolvedModel, effort: model.supportedEffortLevels, autoMode: model.supportsAutoMode })),
    account: { ...init.account, email: init.account?.email ? '(present)' : undefined, organization: init.account?.organization ? '(present)' : undefined },
    outputStyle: init.output_style,
  };
  report.supportedCommandsMatchesInit = JSON.stringify((await query.supportedCommands()).map(command => command.name)) === JSON.stringify(names);
  report.contextModelAtStart = await contextModel();
  if (suites.has('commands')) {
    await turn('plain', 'Reply with exactly PING-OK and nothing else. Do not use any tools.');
    await turn('project-command', '/tt-probe-cmd');
    await turn('project-skill', '/tt-probe-skill');
  }
  if (suites.has('options')) {
    await query.setModel('haiku');
    report.contextModelAfterSetHaiku = await contextModel();
    await turn('model-haiku', 'Reply with exactly MODEL-OK and nothing else. Do not use any tools.');
    await query.setModel('sonnet');
    await query.applyFlagSettings({ effortLevel: 'low' });
    report.contextModelAfterSetSonnet = await contextModel();
    await turn('effort-low', 'Reply with exactly EFFORT-LOW and nothing else. Do not use any tools.');
    await query.applyFlagSettings({ effortLevel: 'high' });
    await query.setPermissionMode('plan');
    await turn('effort-high-plan', 'Reply with exactly EFFORT-HIGH and nothing else. Do not use any tools.');
    await query.setPermissionMode('default');
    await query.applyFlagSettings({ effortLevel: null });
  }
  if (suites.has('interplay')) {
    await query.setModel('haiku');
    await query.applyFlagSettings({ effortLevel: 'high' });
    report.contextModelAfterHaikuEffort = await contextModel();
    await turn('haiku-then-effort', 'Reply with exactly HAIKU-EFFORT and nothing else. Do not use any tools.');
    await query.applyFlagSettings({ effortLevel: null });
    await query.setModel('haiku');
    await query.setPermissionMode('plan');
    report.contextModelAfterHaikuPlan = await contextModel();
    await turn('haiku-then-plan', 'Reply with exactly HAIKU-PLAN and nothing else. Do not use any tools.');
    await query.setPermissionMode('default');
  }
  if (suites.has('approvals')) {
    answers.set('*', 'always');
    await turn('shell-always', 'Use your shell tool to run exactly this command in the current directory: node tt.js  Then reply DONE.');
    answers.set('*', 'deny');
    await turn('shell-repeat', 'Run exactly the same command again with your shell tool: node tt.js  Then reply DONE.');
    answers.set('*', 'always');
    await turn('write-always', 'Use the Write tool to create the file note.txt containing the single word hello. Then reply DONE.');
    answers.set('*', 'deny');
    await turn('edit-repeat', 'Use the Edit tool to change hello to world in note.txt. Then reply DONE.');
  }
  if (suites.has('local')) {
    // Local built-ins without billing, file, browser or cloud side effects. /clear runs last.
    // Never add /extra-usage or /usage-credits: they open the user's browser.
    for (const command of ['/context', '/usage', '/model', '/effort', '/config', '/mcp', '/list-agents', '/reload-skills', '/rename tt-probe', '/autocompact', '/agents', '/goal', '/clear']) {
      await turn(`local ${command}`, command, 60000);
    }
  }
  if (suites.has('commands')) await turn('compact', '/compact');
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  input.end();
  try { query.close?.(); } catch {}
  const projects = join(homedir(), '.claude', 'projects');
  // The closed CLI may keep writing for a few seconds (the SDK allows ~7 s on
  // Windows), and Windows can change the folder name's case.
  const slug = basename(workspace).toLowerCase();
  await new Promise(resolve => setTimeout(resolve, 8000));
  for (const dir of existsSync(projects) ? await readdir(projects) : []) {
    if (dir.toLowerCase().includes(slug)) { await rm(join(projects, dir), { recursive: true, force: true }); report.removedHistoryDir = dir; }
  }
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify(report, null, 2));
}
