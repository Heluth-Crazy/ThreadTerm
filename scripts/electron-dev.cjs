#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const electronBinary = process.platform === 'win32' ? 'electron.cmd' : 'electron';
const entry = path.join('electron', 'main.cjs');
const env = {
  ...process.env,
  NODE_ENV: 'development',
};

const child = spawn(electronBinary, [entry], {
  stdio: 'inherit',
  env,
  shell: false,
});

child.on('error', (error) => {
  console.error(`[electron:dev] Failed to launch Electron: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
