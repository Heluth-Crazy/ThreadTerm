import { describe, expect, it } from 'vitest';
import { parseWorkflow, parseWorkflowDocuments } from './parseWorkflow';

describe('parseWorkflow', () => {
  it('parses a minimal valid workflow (name + command only)', () => {
    const r = parseWorkflow('name: deploy\ncommand: ./deploy.sh\n');
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      expect(r.workflow.name).toBe('deploy');
      expect(r.workflow.command).toBe('./deploy.sh');
      expect(r.droppedFields).toEqual([]);
    }
  });

  it('parses a full workflow including arguments[] and ThreadTerm extensions', () => {
    const yaml = `
name: build-branch
command: git checkout {{branch}} && npm run build
description: Build a feature branch
tags:
  - git
  - build
arguments:
  - name: branch
    description: Git branch to check out
    default_value: main
intent: shell
cwd: ./web
`;
    const r = parseWorkflow(yaml);
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      expect(r.workflow.tags).toEqual(['git', 'build']);
      expect(r.workflow.arguments).toEqual([
        {
          name: 'branch',
          description: 'Git branch to check out',
          default_value: 'main',
        },
      ]);
      expect(r.workflow.intent).toBe('shell');
      expect(r.workflow.cwd).toBe('./web');
      expect(r.droppedFields).toEqual([]);
    }
  });

  it('errors when `name` is missing', () => {
    const r = parseWorkflow('command: ls\n');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.reason).toBe('name-required');
    }
  });

  it('errors when `command` is missing', () => {
    const r = parseWorkflow('name: foo\n');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.reason).toBe('command-required');
    }
  });

  it('drops unknown top-level fields silently and reports them in droppedFields', () => {
    const yaml = `
name: foo
command: ls
foo: bar
unrelated:
  nested: 1
`;
    const r = parseWorkflow(yaml);
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      expect(r.droppedFields).toEqual(expect.arrayContaining(['foo', 'unrelated']));
      expect(r.workflow).not.toHaveProperty('foo');
      expect(r.workflow).not.toHaveProperty('unrelated');
    }
  });

  it('returns an `invalid-yaml` error for malformed YAML', () => {
    const r = parseWorkflow('name: foo\n  command: : :');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.reason).toBe('invalid-yaml');
    }
  });

  it.each([
    ['scalar', '42'],
    ['array', '[1, 2, 3]'],
    ['null', 'null'],
  ])('errors with `not-an-object` when YAML root is %s', (_label, yaml) => {
    const r = parseWorkflow(yaml);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.reason).toBe('not-an-object');
    }
  });

  it('drops malformed argument entries but keeps valid ones', () => {
    const yaml = `
name: x
command: echo {{a}}
arguments:
  - name: a
    default_value: hi
  - description: missing name
  - name: b
    bogus: 1
`;
    const r = parseWorkflow(yaml);
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      expect(r.workflow.arguments).toEqual([
        { name: 'a', default_value: 'hi' },
        { name: 'b' },
      ]);
      expect(r.droppedFields).toEqual(
        expect.arrayContaining(['arguments[1]', 'arguments[2].bogus']),
      );
    }
  });
});

describe('parseWorkflowDocuments', () => {
  it('parses multi-document YAML separated by `---`, returning one result per doc', () => {
    const yaml = `
name: alpha
command: echo a
---
name: beta
command: echo b
`;
    const results = parseWorkflowDocuments(yaml);
    expect(results).toHaveLength(2);
    expect(results[0].kind).toBe('success');
    expect(results[1].kind).toBe('success');
    if (results[0].kind === 'success' && results[1].kind === 'success') {
      expect(results[0].workflow.name).toBe('alpha');
      expect(results[1].workflow.name).toBe('beta');
    }
  });

  it('returns mixed success/error per document when one is invalid', () => {
    const yaml = `
name: good
command: ls
---
command: missing-name
`;
    const results = parseWorkflowDocuments(yaml);
    expect(results).toHaveLength(2);
    expect(results[0].kind).toBe('success');
    expect(results[1].kind).toBe('error');
    if (results[1].kind === 'error') {
      expect(results[1].reason).toBe('name-required');
    }
  });
});
