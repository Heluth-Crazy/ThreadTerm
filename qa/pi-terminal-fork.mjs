import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectPeer } from './pipe-client.mjs';

const [runtimePath, providerInstalls, scratchPrefix, targetVersion] = process.argv.slice(2);
assert.ok(runtimePath && providerInstalls && scratchPrefix, 'usage: node qa/pi-terminal-fork.mjs <runtime> <root with per-version Pi installs> <absolute scratch prefix> [version]');

function seedNativeSession({ packageDir, cwd, recordedCwd, env }) {
  // Use Pi's own writer in the isolated environment before starting the runtime.
  const script = `
    import { resolve } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [packageDir, cwd] = process.argv.slice(1);
    const { SessionManager } = await import(pathToFileURL(resolve(packageDir, 'dist/core/session-manager.js')).href);
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Offline session fixture' }], timestamp: Date.now() });
    console.log(JSON.stringify({ path: session.getSessionFile(), id: session.getSessionId() }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script, packageDir, recordedCwd], {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  }));
}

async function verifyVisualFork({ bin, cwd, env, nativeId, version }) {
  const [{ electron }, { buildQaApp }, { acquireElectronQaLock }] = await Promise.all([
    import('./lib/desktop1.mjs'),
    import('./lib/qa-app.mjs'),
    import('./lib/electron-lock.mjs'),
  ]);
  const root = resolve(import.meta.dirname, '..');
  const out = join(root, 'qa', 'results', 'pi-terminal-fork');
  await mkdir(out, { recursive: true });
  const { appDir, cleanup } = await buildQaApp({ root });
  let app;
  let page;
  let releaseLock;
  const request = (method, params = {}) => page.evaluate(
    ([name, value]) => window.threadterm.request(name, value), [method, params],
  );
  try {
    releaseLock = await acquireElectronQaLock();
    app = await electron.launch({
      args: [appDir], cwd: bin, env: { ...env, THREADTERM_V3_RUNTIME: resolve(runtimePath) }, timeout: 60_000,
    });
    page = await app.firstWindow({ timeout: 30_000 });
    page.setDefaultTimeout(20_000);
    await page.waitForFunction(() => Boolean(window.threadterm));
    await page.locator('#boot-splash').waitFor({ state: 'detached' });
    const setSettings = async patch => {
      const { settings } = await request('runtime.snapshot');
      await request('settings.update', { patch, expectedRevision: settings.revision, operationId: randomUUID() });
    };
    await setSettings({ language: 'en' });
    await request('project.add', { path: cwd, name: 'Pi fork target', operationId: randomUUID() });
    await app.evaluate(({ ipcMain }, target) => {
      ipcMain.removeHandler('threadterm:choose-directory');
      ipcMain.handle('threadterm:choose-directory', () => target);
    }, cwd);
    await page.locator('.nav-item').filter({ hasText: /^All terminals$/u }).click();
    await page.getByRole('button', { name: 'Local history', exact: true }).click();
    const rail = page.locator('.history-rail-native');
    await rail.locator('.history-native-list article').getByRole('button', { name: 'Read', exact: true }).click();
    const button = rail.getByRole('button', { name: 'Fork into terminal…', exact: true });
    await button.waitFor({ state: 'visible' });
    for (const theme of ['light', 'dark']) {
      await setSettings({ theme });
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
      for (const width of [1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await button.focus();
        assert.equal(await button.evaluate(node => node === document.activeElement), true);
        await page.screenshot({ path: join(out, `pi-${version}-${theme}-${width}.png`) });
      }
    }
    await button.press('Enter');
    await page.waitForFunction(async id => {
      const snapshot = await window.threadterm.request('runtime.snapshot', {});
      return snapshot.sessions.some(session => session.provider === 'pi' && session.mode === 'terminal'
        && session.status === 'running' && session.nativeId && session.nativeId !== id);
    }, nativeId);
    console.log(`Pi ${version} Electron history action opened a separate fork terminal`);
  } catch (error) {
    await page?.screenshot({ path: join(out, `pi-${version}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    if (page) await request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
    if (app) await app.close().catch(() => {});
    await releaseLock?.();
    await cleanup();
  }
}

for (const version of targetVersion ? [targetVersion] : ['1.1.0', '1.5.2']) {
  const scratch = await mkdtemp(scratchPrefix);
  const bin = join(scratch, 'bin');
  const cwd = join(scratch, 'target');
  const state = join(scratch, 'agent');
  const data = join(scratch, 'data');
  const temp = join(scratch, 'temp');
  const appData = join(scratch, 'appdata');
  const local = join(scratch, 'local');
  const pipe = '\\\\.\\pipe\\tt-pi-fork-' + randomUUID();
  await Promise.all([bin, cwd, state, data, temp, appData, local].map(path => mkdir(path)));
  const packageDir = resolve(providerInstalls, version, 'node_modules/@earendil-works/pi-coding-agent');
  const cli = join(packageDir, 'dist/bundle/cli.js');
  await writeFile(join(bin, 'pi.cmd'), ['@echo off', `"${process.execPath}" "${cli}" %*`, ''].join('\r\n'));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|ProgramData)$/i.test(key)));
  const env = {
    ...inherited,
    HOME: scratch, USERPROFILE: scratch, HOMEDRIVE: scratch.slice(0, 2), HOMEPATH: scratch.slice(2),
    APPDATA: appData, LOCALAPPDATA: local, TEMP: temp, TMP: temp,
    PI_CODING_AGENT_DIR: state, PI_OFFLINE: '1', THREADTERM_QA_PROVIDER_BIN: bin,
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user-data'), THREADTERM_V3_PIPE: pipe,
  };
  const seeded = seedNativeSession({ packageDir, cwd, recordedCwd: join(scratch, 'missing-source'), env });
  if (process.env.THREADTERM_QA_PI_VISUAL === '1') {
    await verifyVisualFork({ bin, cwd, env, nativeId: seeded.id, version });
    continue;
  }
  const runtime = spawn(resolve(runtimePath), [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let peer;
  let diagnostic = '';
  runtime.stderr.on('data', bytes => { diagnostic += bytes; });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        peer = await connectPeer(pipe + '-control');
        await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
        break;
      } catch (error) {
        peer?.close();
        peer = undefined;
        if (runtime.exitCode !== null) throw error;
        await delay(150);
      }
    }
    assert.ok(peer, 'runtime control pipe opened');
    const project = await peer.request('project.add', { path: cwd, name: 'Pi fork target', operationId: randomUUID() });
    await assert.rejects(
      peer.request('session.create', {
        projectId: project.id, cwd, nativeId: seeded.id, mode: 'terminal', provider: 'pi', operationId: randomUUID(),
      }),
      /fork/i,
      `Pi ${version} ordinary launch must refuse a cwd that can offer a different native identity`,
    );
    const snapshot = await peer.request('runtime.snapshot');
    assert.ok(!snapshot.sessions.some(session => session.nativeId === seeded.id), 'the failed launch claims no terminal');

    const original = await peer.request('history.import', {
      projectId: project.id, cwd, nativeId: seeded.id, mode: 'terminal', provider: 'pi', operationId: randomUUID(),
    });
    const originalBytes = await readFile(seeded.path);
    await assert.rejects(peer.request('session.resume', {
      sessionId: original.id, cwd, resume: true, operationId: randomUUID(),
    }), /fork/i);

    const params = {
      projectId: project.id, cwd, forkFromNativeId: seeded.id, mode: 'terminal',
      provider: 'pi', operationId: randomUUID(),
    };
    await assert.rejects(peer.request('session.create', {
      ...params, cwd: state, operationId: randomUUID(),
    }), /cwd_not_in_registered_project/);
    await assert.rejects(peer.request('session.create', {
      ...params, mode: 'chat', operationId: randomUUID(),
    }), /invalid Pi terminal fork/i);
    const beforeFork = await peer.request('history.list', { provider: 'pi', limit: 20 });
    assert.deepEqual(beforeFork.items.map(item => item.nativeId), [seeded.id], 'rejected requests leave no fork');
    const fork = await peer.request('session.create', params, 45_000);
    assert.notEqual(fork.id, original.id);
    assert.ok(fork.nativeId && fork.nativeId !== original.nativeId, 'the fork owns a distinct native ID');
    assert.equal(fork.status, 'running');
    assert.equal((await peer.request('session.create', params)).id, fork.id, 'replay returns the same fork');
    const updated = await peer.request('runtime.snapshot');
    const originalAfter = updated.sessions.find(session => session.id === original.id);
    assert.equal(originalAfter.nativeId, seeded.id);
    assert.ok(originalAfter.readOnly, 'the original card stays read-only');
    assert.deepEqual(await readFile(seeded.path), originalBytes, 'Pi preserved the original native history');
    const history = await peer.request('history.list', { provider: 'pi', limit: 20 });
    assert.deepEqual(history.items.map(item => item.nativeId).sort(), [seeded.id, fork.nativeId].sort());
    const sessions = join(state, 'sessions');
    const forkFile = (await readdir(sessions, { recursive: true })).find(path => path.endsWith(`_${fork.nativeId}.jsonl`));
    assert.ok(forkFile, 'Pi wrote a durable file for the fork');
    const header = JSON.parse((await readFile(join(sessions, forkFile), 'utf8')).split('\n')[0]);
    assert.equal(header.id, fork.nativeId);
    assert.equal(resolve(header.parentSession), resolve(seeded.path));
    assert.equal(resolve(header.cwd), resolve(cwd));

    const sameDirectory = seedNativeSession({ packageDir, cwd, recordedCwd: cwd, env });
    await assert.rejects(peer.request('session.create', {
      cwd: state, nativeId: sameDirectory.id, mode: 'terminal', provider: 'pi', operationId: randomUUID(),
    }), /fork/i, 'an existing but different directory must also use explicit fork');
    const continued = await peer.request('session.create', {
      projectId: project.id, cwd, nativeId: sameDirectory.id, mode: 'terminal', provider: 'pi', operationId: randomUUID(),
    });
    assert.equal(continued.nativeId, sameDirectory.id, 'same-directory resume continues the original identity');
    console.log(`Pi ${version} fork bound the verified child and preserved the source and normal resume`);
  } catch (error) {
    console.error(diagnostic.slice(-2_000));
    throw error;
  } finally {
    if (peer && runtime.exitCode === null) {
      await peer.request('runtime.shutdown', { operationId: randomUUID() }, 10_000).catch(() => {});
    }
    peer?.close();
    if (runtime.exitCode === null) runtime.kill();
  }
}
