import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { normalizeRelocationPath, canonicalRelocationPath } from './relocationPaths.js';

test('Windows verbatim drive and UNC paths become resolvable plain paths', () => {
  assert.equal(normalizeRelocationPath(String.raw`\\?\Q:\Data\Root`, 'win32'), String.raw`Q:\Data\Root`);
  assert.equal(normalizeRelocationPath(String.raw`\\?\UNC\server\share\Data`, 'win32'), String.raw`\\server\share\Data`);
  assert.equal(normalizeRelocationPath(String.raw`\\?\unc\Server\Share\Data`, 'win32'), String.raw`\\Server\Share\Data`);
});

test('plain drive paths, forward slashes and non-Windows inputs stay unchanged', () => {
  for (const value of [String.raw`Q:\Data\Root`, 'Q:/Data/Root', String.raw`\\server\share\Data`]) {
    assert.equal(normalizeRelocationPath(value, 'win32'), value);
  }
  for (const platform of ['darwin', 'linux']) {
    for (const value of ['/Data/Root', String.raw`\\?\Q:\Data`]) assert.equal(normalizeRelocationPath(value, platform), value);
  }
});

test('canonical comparison resolves aliases before folding mixed case', () => {
  const resolver = (value: string) => {
    assert.equal(value, 'Q:/Alias');
    return String.raw`Q:\Real\MixedCase`;
  };
  assert.equal(canonicalRelocationPath('Q:/Alias', resolver, 'win32'), String.raw`q:\real\mixedcase`);
  assert.throws(() => canonicalRelocationPath('missing', () => { throw new Error('ENOENT'); }, 'win32'), /ENOENT/);
  assert.equal(canonicalRelocationPath('/MiXeD', value => value, 'linux'), '/mixed');
});

test('real filesystem resolution preserves junction/symlink identity and accepts native Windows paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-relocation-paths-'));
  const target = join(root, 'MixedCase');
  const alias = join(root, 'alias');
  mkdirSync(target);
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const expected = canonicalRelocationPath(target, realpathSync, process.platform);
  assert.equal(canonicalRelocationPath(alias, realpathSync, process.platform), expected);
  assert.equal(canonicalRelocationPath(toNamespacedPath(alias), realpathSync, process.platform), expected);
  if (process.platform === 'win32') {
    assert.equal(canonicalRelocationPath(target.replace(/\\/g, '/').toUpperCase(), realpathSync, 'win32'), expected);
  }
});
