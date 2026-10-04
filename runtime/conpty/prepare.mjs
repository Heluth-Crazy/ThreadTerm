// Fetches the pinned ConPTY runtime pair (conpty.dll + OpenConsole.exe) from Microsoft's
// Microsoft.Windows.Console.ConPTY NuGet package (MIT) and verifies it before use:
// archive SHA256, per-file SHA256 and the PE machine type. Nothing is written unless all
// checks pass. Task 10-03-windows-terminal-hardening, stage 2.
//   node runtime/conpty/prepare.mjs --out <dir> [--arch x64|arm64] [--print-hashes]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const CONPTY_PACKAGE = {
  id: 'microsoft.windows.console.conpty',
  version: '1.24.260710001',
  sha256: '175640566A3B59C4B132070EE96C2C77E5AB7EDD2E92732A5EB3610BBF63D90E',
};
const MACHINES = { x64: 0x8664, arm64: 0xaa64 };
/**
 * Where each file sits in the package, and its pinned SHA256 per architecture (taken from the
 * verified archive on 2026-10-03; both files carry a valid Microsoft Corporation Authenticode signature).
 */
const FILES = {
  'conpty.dll': { path: arch => `runtimes/win-${arch}/native/conpty.dll`, sha256: { x64: '39FBA2713E2495117B1591AE8C32A3B904BEA7AA66069CF7815E2844C76D75D8', arm64: 'DB3D173640B172BAFD42D5B541B638A9AEEC1C7D0E40DD636BF02822A32C912C' } },
  'OpenConsole.exe': { path: arch => `build/native/runtimes/${arch}/OpenConsole.exe`, sha256: { x64: 'B7FD936C2668B87B9ECF7B3366DC6568AFC1C6F981874CBA3E955A1C35CF8160', arm64: 'ED7622FD0D3BEDC9AB9F122F5E58EDF0DEF9E7999224F52DD395BA9F54EDBE09' } },
};

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();

/** The PE machine field: `e_lfanew` at 0x3C points at "PE\0\0", followed by the u16 machine. */
export function peMachine(bytes) {
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw Error('not a PE file (no MZ header)');
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.length < pe + 6 || bytes.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw Error('not a PE file (no PE signature)');
  return bytes.readUInt16LE(pe + 4);
}

async function download(url, attempts = 2) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw Error(`download failed: HTTP ${response.status} for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise(done => setTimeout(done, 2000));
    }
  }
}

export async function prepare({ out, arch = 'x64', printHashes = false }) {
  if (!MACHINES[arch]) throw Error(`unsupported architecture ${arch}`);
  const url = `https://api.nuget.org/v3-flatcontainer/${CONPTY_PACKAGE.id}/${CONPTY_PACKAGE.version}/${CONPTY_PACKAGE.id}.${CONPTY_PACKAGE.version}.nupkg`;
  const archive = await download(url);
  if (sha256(archive) !== CONPTY_PACKAGE.sha256) throw Error(`the ConPTY package failed SHA256 verification (got ${sha256(archive)})`);
  const work = mkdtempSync(join(tmpdir(), 'threadterm-conpty-'));
  try {
    const zip = join(work, 'package.zip');
    writeFileSync(zip, archive);
    const members = Object.values(FILES).map(file => file.path(arch));
    // Windows' bsdtar (10 1803+) reads zip archives; by full path, since a GNU tar on PATH
    // (Git for Windows) takes "C:\..." for a remote host.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', zip, '-C', work, ...members], { stdio: 'pipe', windowsHide: true });
    const verified = {};
    for (const [name, file] of Object.entries(FILES)) {
      const bytes = readFileSync(join(work, file.path(arch)));
      const hash = sha256(bytes);
      const pinned = file.sha256[arch];
      if (pinned && hash !== pinned) throw Error(`${name} failed SHA256 verification (got ${hash})`);
      if (peMachine(bytes) !== MACHINES[arch]) throw Error(`${name} is not a ${arch} binary`);
      verified[name] = { bytes, hash, pinned: Boolean(pinned) };
    }
    if (printHashes) for (const [name, { hash, pinned }] of Object.entries(verified)) console.log(`${name} ${arch} SHA256 ${hash}${pinned ? ' (pinned)' : ' (not pinned yet)'}`);
    // Write the complete pair into a fresh folder, then swap it in: never a half pair.
    const target = resolve(out);
    const staging = `${target}.staging`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    for (const [name, { bytes }] of Object.entries(verified)) writeFileSync(join(staging, name), bytes);
    writeFileSync(join(staging, 'VERSION.txt'), `${CONPTY_PACKAGE.id} ${CONPTY_PACKAGE.version} ${arch}\n`);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return { out: target, files: Object.fromEntries(Object.entries(verified).map(([name, { hash }]) => [name, hash])) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
  const out = arg('--out');
  if (!out) throw Error('usage: node runtime/conpty/prepare.mjs --out <dir> [--arch x64|arm64] [--print-hashes]');
  const result = await prepare({ out, arch: arg('--arch') ?? 'x64', printHashes: process.argv.includes('--print-hashes') });
  console.log(JSON.stringify(result, null, 2));
}
