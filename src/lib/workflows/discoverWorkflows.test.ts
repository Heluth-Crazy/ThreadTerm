import { describe, expect, it } from 'vitest';
import {
  discoverWorkflows,
  MAX_WORKFLOW_FILE_BYTES,
  type WorkflowFs,
  type WorkflowFsEntry,
} from './discoverWorkflows';

interface FakeFile {
  size?: number;
  text: string;
}

function makeFs(layout: Record<string, Record<string, FakeFile>>): WorkflowFs {
  return {
    readDir: async (path: string): Promise<WorkflowFsEntry[]> => {
      const dir = layout[path];
      if (!dir) {
        throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
      }
      return Object.entries(dir).map(([name, file]) => ({
        name,
        size: file.size ?? file.text.length,
      }));
    },
    readTextFile: async (path: string): Promise<string> => {
      const slashIdx = path.lastIndexOf('/');
      const dir = path.slice(0, slashIdx);
      const name = path.slice(slashIdx + 1);
      const entry = layout[dir]?.[name];
      if (!entry) throw new Error(`ENOENT: no such file '${path}'`);
      return entry.text;
    },
  };
}

const yamlValid = (name: string, command: string): FakeFile => ({
  text: `name: ${name}\ncommand: ${command}\n`,
});

describe('discoverWorkflows', () => {
  it('returns empty result when both sources are missing and projectDir is null', async () => {
    const fs = makeFs({});
    const r = await discoverWorkflows(fs, { globalDir: '/g', projectDir: null });
    expect(r).toEqual({ workflows: [], errors: [] });
  });

  it('loads a single global workflow when project source is null', async () => {
    const fs = makeFs({
      '/g': { 'a.yaml': yamlValid('alpha', 'echo a') },
    });
    const r = await discoverWorkflows(fs, { globalDir: '/g', projectDir: null });
    expect(r.errors).toEqual([]);
    expect(r.workflows).toHaveLength(1);
    expect(r.workflows[0]).toMatchObject({
      name: 'alpha',
      command: 'echo a',
      source: 'global',
      filePath: '/g/a.yaml',
    });
  });

  it('can load only the project source when globalDir is null', async () => {
    const fs = makeFs({
      '/p': { 'a.yaml': yamlValid('alpha', 'echo a') },
    });
    const r = await discoverWorkflows(fs, { globalDir: null, projectDir: '/p' });
    expect(r.errors).toEqual([]);
    expect(r.workflows).toHaveLength(1);
    expect(r.workflows[0]).toMatchObject({
      name: 'alpha',
      source: 'project',
      filePath: '/p/a.yaml',
    });
  });

  it('lets project workflows override global workflows of the same name', async () => {
    const fs = makeFs({
      '/g': { 'a.yaml': yamlValid('shared', 'global-version') },
      '/p': { 'a.yaml': yamlValid('shared', 'project-version') },
    });
    const r = await discoverWorkflows(fs, { globalDir: '/g', projectDir: '/p' });
    expect(r.errors).toEqual([]);
    expect(r.workflows).toHaveLength(1);
    expect(r.workflows[0]).toMatchObject({
      name: 'shared',
      command: 'project-version',
      source: 'project',
    });
  });

  it('reports parse failures but keeps other workflows in the same source', async () => {
    const fs = makeFs({
      '/g': {
        'good.yaml': yamlValid('good', 'echo ok'),
        'bad.yaml': { text: 'name: broken\n' }, // missing command
      },
    });
    const r = await discoverWorkflows(fs, { globalDir: '/g', projectDir: null });
    expect(r.workflows).toHaveLength(1);
    expect(r.workflows[0].name).toBe('good');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toBe('parse-failed');
    expect(r.errors[0].filePath).toBe('/g/bad.yaml');
  });

  it('skips files larger than MAX_WORKFLOW_FILE_BYTES with a too-large error', async () => {
    const fs = makeFs({
      '/g': {
        'big.yaml': { text: 'name: big\ncommand: ls\n', size: MAX_WORKFLOW_FILE_BYTES + 1 },
        'ok.yaml': yamlValid('ok', 'ls'),
      },
    });
    const r = await discoverWorkflows(fs, { globalDir: '/g', projectDir: null });
    expect(r.workflows.map((w) => w.name)).toEqual(['ok']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ reason: 'too-large', filePath: '/g/big.yaml' });
  });

  it('keeps the first occurrence and reports later duplicates within the same source', async () => {
    const fs = makeFs({
      '/g': {
        'a.yaml': yamlValid('dup', 'first'),
        'b.yaml': yamlValid('dup', 'second'),
      },
    });
    const r = await discoverWorkflows(fs, { globalDir: '/g', projectDir: null });
    expect(r.workflows).toHaveLength(1);
    expect(r.workflows[0].command).toBe('first');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ reason: 'duplicate-name', filePath: '/g/b.yaml' });
  });

  it('treats ENOENT on readDir as silent empty source', async () => {
    const fs: WorkflowFs = {
      readDir: async () => {
        throw new Error("ENOENT: no such file or directory, scandir '/missing'");
      },
      readTextFile: async () => '',
    };
    const r = await discoverWorkflows(fs, { globalDir: '/missing', projectDir: null });
    expect(r).toEqual({ workflows: [], errors: [] });
  });

  it('reports read-failed when readDir rejects with a non-ENOENT error', async () => {
    const fs: WorkflowFs = {
      readDir: async () => {
        throw new Error('EACCES: permission denied');
      },
      readTextFile: async () => '',
    };
    const r = await discoverWorkflows(fs, { globalDir: '/locked', projectDir: null });
    expect(r.workflows).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ reason: 'read-failed', source: 'global' });
  });

  it('reports read-failed when reading an individual file rejects', async () => {
    const fs: WorkflowFs = {
      readDir: async () => [{ name: 'a.yaml', size: 10 }],
      readTextFile: async () => {
        throw new Error('EACCES: permission denied opening file');
      },
    };
    const r = await discoverWorkflows(fs, { globalDir: '/g', projectDir: null });
    expect(r.workflows).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ reason: 'read-failed', filePath: '/g/a.yaml' });
  });

  it('ignores non-yaml files in the discovery directory', async () => {
    const fs = makeFs({
      '/g': {
        'a.yaml': yamlValid('alpha', 'echo a'),
        'README.md': { text: 'docs' },
      },
    });
    const r = await discoverWorkflows(fs, { globalDir: '/g', projectDir: null });
    expect(r.workflows.map((w) => w.name)).toEqual(['alpha']);
    expect(r.errors).toEqual([]);
  });

  it('accepts both .yaml and .YML extensions case-insensitively', async () => {
    const fs = makeFs({
      '/g': {
        'a.YML': yamlValid('alpha', 'echo a'),
      },
    });
    const r = await discoverWorkflows(fs, { globalDir: '/g', projectDir: null });
    expect(r.workflows.map((w) => w.name)).toEqual(['alpha']);
  });
});
