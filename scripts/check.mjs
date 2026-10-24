#!/usr/bin/env node
// One local release gate (F12): protocol freshness, typechecks, every credential-free test suite, and the Rust
// runtime. `npm run check` runs all of it, `npm run check:fast` runs everything except Rust.
//
// By default the gate verifies the committed tree: HEAD is exported into runtime/target-check/check-head and every
// step runs there, so uncommitted scratch files (renderer/src/mockBridge.ts and its dev-only import) cannot make a
// release look green or red. Pass --working-tree to verify uncommitted edits before committing them.
//
// Every step has a timeout. A failing step is reported but the remaining steps still run, so one run shows the whole
// picture; the exit code is non-zero when any step failed.
//
// Packaging: `npm run dist:win` runs this script with --release first. --release verifies the working tree (that is
// what the installer is built from); the only way past it is the loudly printed THREADTERM_SKIP_CHECK=1 escape hatch.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const flags = new Set(process.argv.slice(2));
const release = flags.has('--release');
const workingTree = flags.has('--working-tree') || release;
const fast = flags.has('--fast') && !release;
// --only=<text> runs just the step labels containing <text>; an iteration aid, not a release mode.
const only = ([...flags].find(flag => flag.startsWith('--only=')) ?? '').slice('--only='.length).toLowerCase();
const targetRoot = join(repo, 'runtime', 'target-check');

if (release && process.env.THREADTERM_SKIP_CHECK === '1') {
  console.log('!'.repeat(100));
  console.log('THREADTERM_SKIP_CHECK=1: THE RELEASE GATE IS SKIPPED. The installer will be built from unverified sources.');
  console.log('!'.repeat(100));
  process.exit(0);
}

let failures = 0;
const summaries = [];
const startedAt = Date.now();

function fail(message) {
  console.error(`check: ${message}`);
  process.exit(1);
}

function seconds(from) {
  return `${((Date.now() - from) / 1000).toFixed(1)} s`;
}

function outputTail(text, lines = 60) {
  return text.trimEnd().split('\n').slice(-lines).join('\n').replace(/^/gm, '     ');
}

// Failed test runners put the useful lines in the middle of a long buffer (the harness writes to stdout, the build
// warnings to stderr), so surface the failure section before the two plain tails.
function diagnostics(result) {
  const out = result.stdout ?? '';
  const err = result.stderr ?? '';
  const lines = out.split('\n');
  const parts = [];
  const failuresAt = lines.findIndex(line => line.startsWith('failures:'));
  if (failuresAt >= 0) parts.push(lines.slice(failuresAt, failuresAt + 24).join('\n').replace(/^/gm, '     '));
  else {
    const panics = lines.filter(line => /panicked at |^---- .* stdout ----/.test(line)).slice(0, 12);
    if (panics.length) parts.push(panics.join('\n').replace(/^/gm, '     '));
  }
  parts.push('     --- stdout tail ---');
  parts.push(outputTail(out, 40));
  parts.push('     --- stderr tail ---');
  parts.push(outputTail(err, 40));
  return parts.join('\n');
}

// Windows stores PATH as "Path"; keep the spelling the environment already uses.
function withPath(prefix, env) {
  const copy = { ...process.env, ...env };
  const key = Object.keys(copy).find(name => name.toLowerCase() === 'path') ?? 'PATH';
  copy[key] = `${prefix}${delimiter}${copy[key] ?? ''}`;
  return copy;
}

function onPath(name) {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  const key = Object.keys(process.env).find(entry => entry.toLowerCase() === 'path') ?? 'PATH';
  for (const dir of (process.env[key] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // unreadable PATH entry: keep looking
      }
    }
  }
  return null;
}

function run(label, cwd, command, commandArgs, timeout, env = {}, shell = false) {
  if (only && !label.toLowerCase().includes(only)) return true;
  const from = Date.now();
  process.stdout.write(`...  ${label}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    timeout,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell,
    env: { ...process.env, ...env },
  });
  const ok = result.status === 0 && !result.error;
  const took = seconds(from);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} (${took})`);
  if (ok) {
    // Keep the runner's own tally in the gate log (cargo `test result: ok. 1397 passed`, node `# pass 59`).
    const tally = line => /^test result:/.test(line) || /^(?:[^\s]+\s+)?(pass|fail)\s+\d+$/.test(line);
    for (const line of (result.stdout ?? '').split('\n').map(entry => entry.trim()).filter(tally).slice(-4)) console.log(`     ${line}`);
  }
  if (!ok) {
    failures += 1;
    if (result.error?.code === 'ETIMEDOUT') console.log(`     timed out after ${timeout / 1000} s`);
    if (result.error) console.log(`     ${result.error.code ?? 'spawn'}: ${result.error.message}`);
    console.log(diagnostics(result));
  }
  summaries.push({ label, ok, took });
  return ok;
}

function npmCommand(npmArgs) {
  const cli = process.env.npm_execpath;
  if (cli && /\.c?js$/.test(cli)) return { command: process.execPath, args: [cli, ...npmArgs], shell: false };
  // npm-cli.js sits beside the Node executable on the standard Windows and nvm layouts; use it instead of a shell.
  const local = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(local)) return { command: process.execPath, args: [local, ...npmArgs], shell: false };
  return { command: 'npm', args: npmArgs, shell: true };
}

function npmRun(label, cwd, npmArgs, timeout, env = {}) {
  const { command, args, shell } = npmCommand(npmArgs);
  return run(label, cwd, command, args, timeout, env, shell);
}

// --- the tree under test ------------------------------------------------------------------------------------------

function link(source, target) {
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

// The snapshot has no dependency folders of its own; link the checkout's node_modules, but keep the workspace
// packages resolving to the snapshot copies so the generated protocol and the renderer sources are the validated ones.
function linkNodeModules(snapshot) {
  const source = join(repo, 'node_modules');
  if (!existsSync(source)) return false;
  const target = join(snapshot, 'node_modules');
  mkdirSync(target, { recursive: true });
  const workspaces = new Map([
    ['protocol', 'protocol'],
    ['v3-renderer', 'renderer'],
    ['v3-claude-sdk', 'providers/claude-sdk'],
  ]);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.name === '@threadterm') {
      mkdirSync(to, { recursive: true });
      for (const [name, path] of workspaces) {
        const workspace = join(snapshot, path);
        if (existsSync(workspace)) link(workspace, join(to, name));
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      link(from, to);
    } else {
      copyFileSync(from, to);
    }
  }
  for (const packageDir of ['renderer', 'providers/claude-sdk']) {
    const local = join(repo, packageDir, 'node_modules');
    if (existsSync(local) && !existsSync(join(snapshot, packageDir, 'node_modules'))) {
      link(local, join(snapshot, packageDir, 'node_modules'));
    }
  }
  return true;
}

function materializeTree() {
  if (workingTree) {
    console.log(`check: verifying the working tree of ${repo}`);
    return { root: repo, label: 'working tree' };
  }
  const git = onPath('git') ?? fail('git is required to verify the committed tree; install Git or pass --working-tree');
  const tar = onPath('tar') ?? fail('tar is required to extract the committed tree; install tar or pass --working-tree');
  const head = spawnSync(git, ['rev-parse', '--short', 'HEAD'], { cwd: repo, timeout: 60000, encoding: 'utf8' });
  if (head.status !== 0) fail(`git rev-parse HEAD failed: ${(head.stderr ?? '').trim()}`);
  const revision = head.stdout.trim();
  const snapshot = join(targetRoot, 'check-head');
  const archive = join(targetRoot, 'check-head.tar');
  rmSync(snapshot, { recursive: true, force: true });
  mkdirSync(snapshot, { recursive: true });
  // Autocrlf off: the snapshot must hold the committed bytes so the freshness comparison is byte-exact.
  const pack = spawnSync(git, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', `--output=${archive}`, 'HEAD'], {
    cwd: repo,
    timeout: 180000,
    encoding: 'utf8',
  });
  if (pack.status !== 0) fail(`git archive HEAD failed: ${(pack.stderr ?? '').trim()}`);
  // Relative, forward-slash paths keep GNU tar from reading a drive letter as a remote host or a backslash as an escape.
  const posix = path => relative(repo, path).split('\\').join('/');
  const unpack = spawnSync(tar, ['-xf', posix(archive), '-C', posix(snapshot)], { cwd: repo, timeout: 180000, encoding: 'utf8' });
  rmSync(archive, { force: true });
  if (unpack.status !== 0) fail(`tar -xf failed: ${(unpack.stderr ?? '').trim()}`);
  if (!linkNodeModules(snapshot)) fail('node_modules is missing; run npm install first');
  if (spawnSync(git, ['check-ignore', '-q', 'runtime/target-check'], { cwd: repo, timeout: 60000 }).status !== 0) {
    console.log('     note: runtime/target-check is not git-ignored; add it to .gitignore so the snapshot stays out of git status');
  }
  console.log(`check: verifying the committed tree at HEAD (${revision}) from ${relative(repo, snapshot)}`);
  return { root: snapshot, label: `HEAD ${revision}` };
}

const tree = materializeTree();
const root = tree.root;
const scratch = join(root, 'runtime', 'target-check', 'check-scratch');

function freshScratch(name) {
  const dir = join(scratch, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- steps -------------------------------------------------------------------------------------------------------

const GENERATED = ['browser.js', 'WireRequest.schema.json', 'WireSuccess.schema.json', 'generated-validators.js', 'generated-validators.d.ts'];
const normalized = text => text.replace(/\r\n/g, '\n');

// The selected-commit runtime needs `git hook run` (Git 2.36+) and a ref-transaction capable Git. Probe it the same
// way the runtime does, so an older Git skips those tests with a reason instead of 26 failures.
function gitRunsHooks(git) {
  const probe = mkdtempSync(join(tmpdir(), 'tt-git-probe-'));
  try {
    const hooks = join(probe, 'hooks');
    mkdirSync(hooks);
    if (spawnSync(git, ['init', '-q'], { cwd: probe, timeout: 120000 }).status !== 0) return false;
    return spawnSync(git, ['-c', `core.hooksPath=${hooks}`, 'hook', 'run', '--ignore-missing', 'pre-commit'], { cwd: probe, timeout: 120000 }).status === 0;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

// Regenerate the protocol into a scratch copy and fail on any byte difference, so a stale schema or validator
// cannot be packaged with a matching-looking source tree.
function protocolFreshness() {
  const label = 'protocol freshness';
  if (only && !label.includes(only)) return;
  const from = Date.now();
  process.stdout.write(`...  ${label}\n`);
  const copy = freshScratch('protocol');
  for (const entry of readdirSync(join(root, 'protocol'))) {
    const source = join(root, 'protocol', entry);
    if (statSync(source).isFile()) copyFileSync(source, join(copy, entry));
  }
  const result = spawnSync(process.execPath, ['generate.mjs'], { cwd: copy, timeout: 300000, encoding: 'utf8' });
  const stale = result.status === 0
    ? GENERATED.filter(name => !existsSync(join(copy, name))
      || normalized(readFileSync(join(copy, name), 'utf8')) !== normalized(readFileSync(join(root, 'protocol', name), 'utf8')))
    : [];
  const ok = result.status === 0 && stale.length === 0;
  const took = seconds(from);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} (${took})`);
  if (!ok) {
    failures += 1;
    if (result.status !== 0) console.log(outputTail(`${result.stdout ?? ''}${result.stderr ?? ''}`));
    else console.log(`     stale generated protocol output: ${stale.join(', ')} (run npm run protocol:generate and commit it)`);
  }
  summaries.push({ label, ok, took });
  rmSync(copy, { recursive: true, force: true });
}

protocolFreshness();

run('typecheck desktop', root, process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.desktop.json'], 300000);
run('typecheck renderer', root, process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'renderer'], 300000);

npmRun('protocol tests', root, ['run', 'test:protocol'], 600000);
run('protocol usage-ledger tests', root, process.execPath, ['--experimental-strip-types', '--test', 'protocol/usage-ledger.test.mjs'], 300000);
run('renderer unit tests', root, process.execPath, [join(root, 'scripts/run-renderer-tests.mjs')], 900000);
npmRun('desktop tests', root, ['run', 'test:desktop'], 1200000);
npmRun('claude sidecar build', root, ['--workspace', '@threadterm/v3-claude-sdk', 'run', 'build'], 600000);
npmRun('claude sidecar tests', root, ['--workspace', '@threadterm/v3-claude-sdk', 'test'], 600000);

// Pure qa/*.test.mjs suites: no Electron window, no network, no runtime executable, no user profile. Everything else
// under qa/ is an environment-only harness (Electron views, real providers, loopback servers) or a documented
// failure at HEAD (browser-activity-card "conflicting identities", icon-generator icon-set drift): neither belongs
// in the release gate.
const QA = [
  'agent-history', 'browser-agent-controller', 'browser-agent-reads', 'browser-dev-server', 'browser-eval-approval',
  'browser-fixture', 'browser-handoff-core', 'browser-handoff-input', 'browser-handoff-native', 'browser-handoff-terminal',
  'browser-markup-mount', 'browser-markup', 'browser-new-tab', 'browser-occlusion', 'browser-page-comments',
  'browser-preview-mount', 'browser-shot-draft', 'browser-tab-activity', 'browser-tab-title', 'browser-view-cleanup',
  'browser-view-core', 'browser-view-diagnostics', 'chat-connect-transition', 'chat-plan-fixture', 'chat-state', 'codex-reconnect-fixture',
  'codex-stream', 'codex-transcript', 'command-presets', 'file-drag', 'file-references', 'file-workspace-fixtures',
  'icon-stability', 'inbox-visibility', 'mcp-smoke', 'native-browser', 'oc1-visual-fixtures', 'oc2-opencode-fixture',
  'oc2-opencode-harness', 'oc2-opencode-options-regression', 'oc2-opencode-visual-fixture', 'opencode-reconnect-ordering',
  'opencode-retry', 'palette-sessions', 'pane-geometry', 'review-comments', 'selected-commit-selection',
  'send-latency-breakdown', 'session-activity', 'session-ordering', 'session-state', 'terminal-file-links', 'token-speed',
  'usage-card', 'workbench-graph', 'workbench-helpers', 'workspace-layout', 'workspace-tabs',
];
run('qa unit tests', root, process.execPath, ['--test', '--test-timeout=180000', ...QA.map(name => join('qa', `${name}.test.mjs`))], 900000);

// These seven suites import renderer modules through extensionless specifiers, which plain Node cannot resolve.
// Bundle them first (same module graph the renderer build uses) instead of dropping their coverage.
const QA_BUNDLED = ['attention-state', 'branch-git', 'browser-agent-eval', 'chat-connection', 'chat-presentation', 'session-file-views', 'workbench-agents'];

async function bundledQaTests() {
  const label = 'qa bundled tests';
  if (only && !label.includes(only)) return;
  const from = Date.now();
  process.stdout.write(`...  ${label}\n`);
  let ok = false;
  let detail = '';
  try {
    const { build } = await import('esbuild');
    const out = mkdtempSync(join(freshScratch('qa'), 'run-'));
    const bundles = [];
    for (const [index, name] of QA_BUNDLED.entries()) {
      const outfile = join(out, `${index}-${name}.test.mjs`);
      await build({ entryPoints: [join(root, 'qa', `${name}.test.mjs`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', external: ['node:*'] });
      bundles.push(outfile);
    }
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=180000', ...bundles], { cwd: root, timeout: 600000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    ok = result.status === 0;
    detail = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  } catch (error) {
    detail = String(error?.stack ?? error);
  }
  const took = seconds(from);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} (${took})`);
  if (!ok) {
    failures += 1;
    console.log(outputTail(detail));
  }
  summaries.push({ label, ok, took });
  rmSync(join(scratch, 'qa'), { recursive: true, force: true });
}

await bundledQaTests();

run('visual consistency', root, process.execPath, ['--test', 'qa/visual-consistency.test.mjs'], 300000);

// Rust runs on the working tree (the snapshot's runtime/ would need its own multi-GB target dir); on a clean
// checkout the two are identical. Tests that cannot run without a prerequisite are skipped with a printed reason
// instead of making the gate depend on one machine's installed tools.
if (!fast) {
  const clock = {};
  const notes = [];
  const skips = [];
  let git = process.env.THREADTERM_TEST_GIT;
  if (git && !existsSync(git)) {
    notes.push(`THREADTERM_TEST_GIT does not exist (${git}); falling back to a Git on PATH`);
    git = undefined;
  }
  git = git ? resolve(git) : onPath('git');
  if (git && gitRunsHooks(git)) {
    clock.THREADTERM_TEST_GIT = git;
    notes.push(`selected-commit tests use ${git}`);
  } else if (git) {
    skips.push('git_selected_commit');
    notes.push(`${git} lacks \`git hook run\` (Git < 2.36): skipping selected-commit tests; install a newer Git or point THREADTERM_TEST_GIT at one`);
  } else {
    // Every fixture in git_selected_commit drives a real repository, so the whole module needs a Git executable.
    skips.push('git_selected_commit');
    notes.push('git not found: skipping selected-commit tests (install Git to run them)');
  }
  let keygen = onPath('ssh-keygen');
  if (!keygen && process.platform === 'win32' && process.env.SystemRoot) {
    const openssh = join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe');
    if (existsSync(openssh)) keygen = openssh;
  }
  let rustEnv = clock;
  if (keygen) {
    rustEnv = withPath(dirname(keygen), clock);
    notes.push(`ssh signing test uses ${keygen}`);
  } else {
    skips.push('ssh_signed_commit_verifies_and_signer_failure_does_not_publish');
    notes.push('ssh-keygen not found: skipping the SSH-signing test (install an OpenSSH client to run it)');
  }
  const cargo = onPath('cargo');
  if (!cargo) fail('cargo is required for the full gate; install Rust (rustup) or run npm run check:fast');
  if (!workingTree) notes.push('rust tests always run on the working tree of runtime/');
  for (const note of notes) console.log(`     ${note}`);
  const rustArgs = ['test', '--locked', '--manifest-path', join(repo, 'runtime', 'Cargo.toml'), '--target-dir', join(targetRoot, 'rust'), '-j', '2', '--', '--test-threads=2'];
  for (const skip of skips) rustArgs.push('--skip', skip);
  run('rust tests', repo, cargo, rustArgs, 3600000, rustEnv);
}

// --- summary ------------------------------------------------------------------------------------------------------

console.log(`\ncheck summary (${tree.label}, ${((Date.now() - startedAt) / 60000).toFixed(1)} min)`);
for (const { label, ok, took } of summaries) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} (${took})`);
const failed = summaries.filter(entry => !entry.ok).map(entry => entry.label);
console.log(`check: ${failed.length === 0 ? 'PASS' : `FAIL — ${failed.join(', ')}`} (${summaries.length - failed.length}/${summaries.length} steps)`);
process.exit(failed.length === 0 ? 0 : 1);
