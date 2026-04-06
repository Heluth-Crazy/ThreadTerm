import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeMessageId,
  flattenFiles,
  normalizeTreeNodes,
  getFuzzySubsequenceScore,
  scoreMentionCandidate,
  extractText,
  stripKnownXmlArtifacts,
  normalizeDisplayText,
  shouldSkipNoisyMessage,
  toToolResultPreview,
  escapeRegex,
  stripReferencedMentions,
  stripEmbeddedFileContext,
  isListItemLine,
  compactMessageText,
  shouldRenderAsPreformatted,
  getProviderMessageType,
  getStorageKeyForModel,
  getProviderDisplayName,
  normalizeLaunchArgs,
} from './chatUtils';
import type { FlatFileNode, FileTreeNode } from '../types/chatTypes';

describe('chatUtils', () => {
  // --- makeMessageId ---
  describe('makeMessageId', () => {
    it('should return a unique string each call', () => {
      const id1 = makeMessageId();
      const id2 = makeMessageId();
      expect(typeof id1).toBe('string');
      expect(id1).not.toBe(id2);
    });
  });

  // --- flattenFiles ---
  describe('flattenFiles', () => {
    it('should flatten nested file tree into flat array', () => {
      const tree: FileTreeNode[] = [
        {
          path: '/src',
          name: 'src',
          type: 'directory',
          children: [
            { path: '/src/index.ts', name: 'index.ts', type: 'file', children: [] },
          ],
        },
      ];
      const result = flattenFiles(tree);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ path: '/src', name: 'src', type: 'directory' });
      expect(result[1]).toEqual({ path: '/src/index.ts', name: 'index.ts', type: 'file' });
    });

    it('should skip invalid nodes', () => {
      const tree: any[] = [null, undefined, { bad: true }, { type: 'file', path: '/a', name: 'a', children: [] }];
      const result = flattenFiles(tree);
      expect(result).toHaveLength(1);
    });
  });

  // --- normalizeTreeNodes ---
  describe('normalizeTreeNodes', () => {
    it('should return empty array for non-array input', () => {
      expect(normalizeTreeNodes(null as any)).toEqual([]);
    });

    it('should sort directories before files, then alphabetically', () => {
      const nodes: any[] = [
        { path: '/b.ts', name: 'b.ts', type: 'file' },
        { path: '/a', name: 'a', type: 'directory' },
        { path: '/c.ts', name: 'c.ts', type: 'file' },
      ];
      const result = normalizeTreeNodes(nodes);
      expect(result[0].name).toBe('a');
      expect(result[1].name).toBe('b.ts');
      expect(result[2].name).toBe('c.ts');
    });

    it('should skip nodes with invalid type or missing path/name', () => {
      const nodes: any[] = [
        { path: '/a', name: 'a', type: 'unknown' },
        { path: '/b', type: 'file' },
        { name: 'c', type: 'file' },
        { path: '/d', name: 'd', type: 'file' },
      ];
      const result = normalizeTreeNodes(nodes);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('d');
    });
  });

  // --- getFuzzySubsequenceScore ---
  describe('getFuzzySubsequenceScore', () => {
    it('should return 0 for empty query', () => {
      expect(getFuzzySubsequenceScore('hello', '')).toBe(0);
    });

    it('should return -1 when query is not a subsequence', () => {
      expect(getFuzzySubsequenceScore('abc', 'xyz')).toBe(-1);
    });

    it('should return positive score for valid subsequence', () => {
      const score = getFuzzySubsequenceScore('index.ts', 'idx');
      expect(score).toBeGreaterThan(0);
    });

    it('should score exact prefix higher than spread match', () => {
      const prefixScore = getFuzzySubsequenceScore('abc', 'ab');
      const spreadScore = getFuzzySubsequenceScore('a___b', 'ab');
      expect(prefixScore).toBeGreaterThan(spreadScore);
    });
  });

  // --- scoreMentionCandidate ---
  describe('scoreMentionCandidate', () => {
    it('should return base score for empty query (directory > file)', () => {
      const dir: FlatFileNode = { path: '/src', name: 'src', type: 'directory' };
      const file: FlatFileNode = { path: '/a.ts', name: 'a.ts', type: 'file' };
      expect(scoreMentionCandidate(dir, '')).toBe(12);
      expect(scoreMentionCandidate(file, '')).toBe(10);
    });

    it('should return 2000 for exact name match', () => {
      const entry: FlatFileNode = { path: '/src/utils.ts', name: 'utils.ts', type: 'file' };
      expect(scoreMentionCandidate(entry, 'utils.ts')).toBe(2000);
    });

    it('should return -1 for completely unrelated query', () => {
      const entry: FlatFileNode = { path: '/src/a.ts', name: 'a.ts', type: 'file' };
      expect(scoreMentionCandidate(entry, 'zzzzzzzzz')).toBe(-1);
    });

    it('should score name prefix higher than substring', () => {
      const entry: FlatFileNode = { path: '/src/index.ts', name: 'index.ts', type: 'file' };
      const prefixScore = scoreMentionCandidate(entry, 'ind');
      const substringScore = scoreMentionCandidate(entry, 'dex');
      expect(prefixScore).toBeGreaterThan(substringScore);
    });
  });

  // --- extractText ---
  describe('extractText', () => {
    it('should return empty string for falsy input', () => {
      expect(extractText(null)).toBe('');
      expect(extractText(undefined)).toBe('');
      expect(extractText('')).toBe('');
    });

    it('should return the string itself', () => {
      expect(extractText('hello')).toBe('hello');
    });

    it('should extract text from object with .text property', () => {
      expect(extractText({ text: 'world' })).toBe('world');
    });

    it('should extract from nested content arrays', () => {
      const payload = { content: [{ text: 'a' }, { text: 'b' }] };
      expect(extractText(payload)).toBe('a\nb');
    });

    it('should extract from .message property', () => {
      expect(extractText({ message: 'err msg' })).toBe('err msg');
    });
  });

  // --- stripKnownXmlArtifacts ---
  describe('stripKnownXmlArtifacts', () => {
    it('should strip <thinking> tags', () => {
      const input = 'before<thinking>secret</thinking>after';
      expect(stripKnownXmlArtifacts(input)).toBe('beforeafter');
    });

    it('should strip <system-reminder> tags', () => {
      const input = 'text<system-reminder>reminder</system-reminder>more';
      expect(stripKnownXmlArtifacts(input)).toBe('textmore');
    });

    it('should unwrap <command-name> content', () => {
      const input = '<command-name>git push</command-name>';
      expect(stripKnownXmlArtifacts(input)).toBe('git push');
    });
  });

  // --- normalizeDisplayText ---
  describe('normalizeDisplayText', () => {
    it('should return empty string for falsy payload', () => {
      expect(normalizeDisplayText(null)).toBe('');
    });

    it('should normalize CRLF and collapse excess newlines', () => {
      const input = 'line1\r\nline2\r\n\r\n\r\n\r\nline3';
      const result = normalizeDisplayText(input);
      expect(result).toBe('line1\nline2\n\nline3');
    });
  });

  // --- shouldSkipNoisyMessage ---
  describe('shouldSkipNoisyMessage', () => {
    it('should skip empty/whitespace text', () => {
      expect(shouldSkipNoisyMessage('')).toBe(true);
      expect(shouldSkipNoisyMessage('   ')).toBe(true);
    });

    it('should skip known noisy messages', () => {
      expect(shouldSkipNoisyMessage('exit')).toBe(true);
      expect(shouldSkipNoisyMessage('Bye!')).toBe(true);
      expect(shouldSkipNoisyMessage('Goodbye!')).toBe(true);
      expect(shouldSkipNoisyMessage('caveat: something')).toBe(true);
    });

    it('should not skip normal messages', () => {
      expect(shouldSkipNoisyMessage('Hello, how can I help?')).toBe(false);
    });
  });

  // --- toToolResultPreview ---
  describe('toToolResultPreview', () => {
    it('should return empty string for empty payload', () => {
      expect(toToolResultPreview(null)).toBe('');
    });

    it('should return full text when under limit', () => {
      expect(toToolResultPreview('short text')).toBe('short text');
    });

    it('should truncate long text with char count', () => {
      const longText = 'x'.repeat(5000);
      const result = toToolResultPreview(longText);
      expect(result).toContain('[...truncated');
      expect(result.length).toBeLessThan(longText.length);
    });
  });

  // --- escapeRegex ---
  describe('escapeRegex', () => {
    it('should escape special regex characters', () => {
      expect(escapeRegex('file.ts')).toBe('file\\.ts');
      expect(escapeRegex('a(b)')).toBe('a\\(b\\)');
      expect(escapeRegex('a[b]')).toBe('a\\[b\\]');
    });
  });

  // --- stripReferencedMentions ---
  describe('stripReferencedMentions', () => {
    it('should return empty for empty text', () => {
      expect(stripReferencedMentions('', [])).toBe('');
    });

    it('should strip @path mentions from text', () => {
      const text = 'Please check @src/index.ts for errors';
      const result = stripReferencedMentions(text, ['src/index.ts']);
      expect(result).not.toContain('@src/index.ts');
    });

    it('should leave text intact when no paths provided', () => {
      const text = 'Hello @world';
      expect(stripReferencedMentions(text, [])).toBe('Hello @world');
    });
  });

  // --- stripEmbeddedFileContext ---
  describe('stripEmbeddedFileContext', () => {
    it('should return empty for empty input', () => {
      expect(stripEmbeddedFileContext('')).toBe('');
    });

    it('should strip referenced paths section', () => {
      const text = 'main content\n\nReferenced paths:\n/src/a.ts\n/src/b.ts';
      expect(stripEmbeddedFileContext(text)).toBe('main content');
    });

    it('should return full text when no marker found', () => {
      expect(stripEmbeddedFileContext('no markers here')).toBe('no markers here');
    });
  });

  // --- isListItemLine ---
  describe('isListItemLine', () => {
    it('should detect dash list items', () => {
      expect(isListItemLine('- item')).toBe(true);
      expect(isListItemLine('  - nested')).toBe(true);
    });

    it('should detect numbered list items', () => {
      expect(isListItemLine('1. first')).toBe(true);
    });

    it('should reject non-list lines', () => {
      expect(isListItemLine('just text')).toBe(false);
    });
  });

  // --- compactMessageText ---
  describe('compactMessageText', () => {
    it('should return empty for empty input', () => {
      expect(compactMessageText('')).toBe('');
    });

    it('should collapse multiple blank lines', () => {
      const input = 'a\n\n\n\nb';
      const result = compactMessageText(input);
      expect(result).toBe('a\n\nb');
    });

    it('should remove blank lines around list items', () => {
      const input = 'intro\n\n- item 1\n\n- item 2\n\nend';
      const result = compactMessageText(input);
      expect(result).not.toMatch(/\n\n- item/);
    });
  });

  // --- shouldRenderAsPreformatted ---
  describe('shouldRenderAsPreformatted', () => {
    it('should return false for empty or single-line text', () => {
      expect(shouldRenderAsPreformatted('')).toBe(false);
      expect(shouldRenderAsPreformatted('single line')).toBe(false);
    });

    it('should return false for markdown tables (pipe chars)', () => {
      const table = '| Col1 | Col2 |\n| --- | --- |\n| a | b |';
      expect(shouldRenderAsPreformatted(table)).toBe(false);
    });

    it('should return true for aligned column text', () => {
      const text = 'Name      Age   City\nAlice     30    NYC\nBob       25    LA\nCarol     28    SF';
      expect(shouldRenderAsPreformatted(text)).toBe(true);
    });
  });

  // --- getProviderMessageType ---
  describe('getProviderMessageType', () => {
    it('should return codex-command for codex', () => {
      expect(getProviderMessageType('codex')).toBe('codex-command');
    });

    it('should return claude-command for claude', () => {
      expect(getProviderMessageType('claude')).toBe('claude-command');
    });
  });

  // --- getStorageKeyForModel ---
  describe('getStorageKeyForModel', () => {
    it('should return correct storage key', () => {
      expect(getStorageKeyForModel('claude')).toBe('chat-model-claude');
      expect(getStorageKeyForModel('codex')).toBe('chat-model-codex');
    });
  });

  // --- getProviderDisplayName ---
  describe('getProviderDisplayName', () => {
    it('should return display name for each provider', () => {
      expect(getProviderDisplayName('codex')).toBe('OpenAI Codex');
      expect(getProviderDisplayName('claude')).toBe('Claude');
    });
  });

  // --- normalizeLaunchArgs ---
  describe('normalizeLaunchArgs', () => {
    it('should return empty array for non-array input', () => {
      expect(normalizeLaunchArgs(null)).toEqual([]);
      expect(normalizeLaunchArgs(undefined)).toEqual([]);
      expect(normalizeLaunchArgs('string')).toEqual([]);
    });

    it('should trim and filter out empty strings', () => {
      expect(normalizeLaunchArgs(['  --flag  ', '', '  ', 'value'])).toEqual(['--flag', 'value']);
    });

    it('should convert non-string elements to empty string then filter', () => {
      expect(normalizeLaunchArgs([123, null, '--ok'])).toEqual(['--ok']);
    });
  });
});
