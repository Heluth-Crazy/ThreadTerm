import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DESCRIPTOR_ENV = 'THREADTERM_REAL_BRIDGE_DESCRIPTOR_PATH';
const FIXTURE_TIMEOUT_MS = 240_000;

export default async function globalSetup() {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'threadterm-real-bridge-'));
  const descriptorPath = path.join(fixtureDir, 'descriptor.json');
  const stopPath = path.join(fixtureDir, 'stop');
  const child = startFixture(fixtureDir);

  try {
    await waitForDescriptor(child, descriptorPath);
    process.env[DESCRIPTOR_ENV] = descriptorPath;
  } catch (error) {
    child.kill();
    rmSync(fixtureDir, { force: true, recursive: true });
    throw error;
  }

  return async () => {
    writeFileSync(stopPath, 'stop');
    await Promise.race([once(child, 'exit'), delay(10_000)]);
    if (child.exitCode === null) child.kill();
    delete process.env[DESCRIPTOR_ENV];
    rmSync(fixtureDir, { force: true, recursive: true });
  };
}

function startFixture(fixtureDir: string): ChildProcessWithoutNullStreams {
  const command = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  return spawn(
    command,
    [
      'test',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--lib',
      'bridge::tests::browser_e2e_fixture_server',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        THREADTERM_REAL_BRIDGE_FIXTURE_DIR: fixtureDir,
      },
      stdio: 'pipe',
      windowsHide: true,
    },
  );
}

async function waitForDescriptor(
  child: ChildProcessWithoutNullStreams,
  descriptorPath: string,
): Promise<void> {
  let output = '';
  let spawnError: Error | null = null;
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.once('error', (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + FIXTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Could not start the real bridge fixture: ${spawnError.message}`);
    }
    if (existsSync(descriptorPath)) {
      try {
        JSON.parse(readFileSync(descriptorPath, 'utf8'));
        return;
      } catch {
        await delay(100);
        continue;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Real bridge fixture exited before it became ready (code ${child.exitCode}, signal ${child.signalCode}).\n${output}`,
      );
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for the real bridge fixture.\n${output}`);
}
