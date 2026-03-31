#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');

function parseEnvFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in result)) {
      result[key] = value;
    }
  }
  return result;
}

function getPortValues() {
  const fileEnv = parseEnvFile(envPath);
  const serverPort = Number(process.env.PORT || fileEnv.PORT || 3001);
  const vitePort = Number(process.env.VITE_PORT || fileEnv.VITE_PORT || 5173);
  return [serverPort, vitePort].filter((value) => Number.isInteger(value) && value > 0);
}

function killPortsOnWindows(ports) {
  const killed = new Set();
  for (const port of ports) {
    let output = '';
    try {
      output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue;
    }

    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      // Expected netstat TCP format:
      // Proto LocalAddress ForeignAddress State PID
      if (parts.length < 5) continue;
      const localAddress = parts[1] || '';
      const state = (parts[3] || '').toUpperCase();
      const pidRaw = parts[4];
      // Only kill listeners bound to the target port.
      if (!localAddress.endsWith(`:${port}`)) continue;
      if (state !== 'LISTENING') continue;
      const procId = Number(pidRaw);
      if (!Number.isInteger(procId) || procId <= 0) continue;
      if (killed.has(procId)) continue;
      try {
        execSync(`taskkill /PID ${procId} /F /T`, { stdio: 'ignore' });
        killed.add(procId);
      } catch {
        // Ignore failures (already exited or no permission)
      }
    }
  }

  if (killed.size > 0) {
    console.log(`[dev-cleanup] Killed processes: ${Array.from(killed).join(', ')}`);
  } else {
    console.log('[dev-cleanup] No stale dev processes found');
  }
}

function killPortsOnUnix(ports) {
  const killed = new Set();
  for (const port of ports) {
    let output = '';
    try {
      output = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue;
    }
    const pids = output.split(/\r?\n/).map((line) => Number(line.trim())).filter((value) => Number.isInteger(value) && value > 0);
    for (const procId of pids) {
      if (killed.has(procId)) continue;
      try {
        process.kill(procId, 'SIGKILL');
        killed.add(procId);
      } catch {
        // Ignore failures
      }
    }
  }

  if (killed.size > 0) {
    console.log(`[dev-cleanup] Killed processes: ${Array.from(killed).join(', ')}`);
  } else {
    console.log('[dev-cleanup] No stale dev processes found');
  }
}

const ports = getPortValues();
if (ports.length === 0) {
  console.log('[dev-cleanup] No ports to check');
  process.exit(0);
}

if (process.platform === 'win32') {
  killPortsOnWindows(ports);
} else {
  killPortsOnUnix(ports);
}
