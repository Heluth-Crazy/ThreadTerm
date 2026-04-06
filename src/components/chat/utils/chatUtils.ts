import type { SessionProvider, Project, ProjectSession } from '../../../types/app';
import type { FlatFileNode, FileTreeNode } from '../types/chatTypes';
import { loadSessionLaunchProfilesByProvider, mergeSessionLaunchArgs } from '../../../utils/sessionLaunchProfiles';
import { MAX_TOOL_RESULT_PREVIEW_CHARS, BYPASS_PERMISSION_FLAGS } from './chatConstants';

export const makeMessageId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const flattenFiles = (nodes: FileTreeNode[], bucket: FlatFileNode[] = []): FlatFileNode[] => {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      continue;
    }
    if (
      (node.type === 'file' || node.type === 'directory') &&
      typeof node.path === 'string' &&
      typeof node.name === 'string'
    ) {
      bucket.push({ path: node.path, name: node.name, type: node.type });
    }
    if (node.type === 'directory' && Array.isArray(node.children)) {
      flattenFiles(node.children, bucket);
    }
  }
  return bucket;
};

export const normalizeTreeNodes = (nodes: any[]): FileTreeNode[] => {
  if (!Array.isArray(nodes)) {
    return [];
  }

  const normalized: FileTreeNode[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      continue;
    }

    if ((node.type !== 'file' && node.type !== 'directory') || typeof node.path !== 'string' || typeof node.name !== 'string') {
      continue;
    }

    const children = node.type === 'directory' && Array.isArray(node.children)
      ? normalizeTreeNodes(node.children)
      : [];

    normalized.push({
      path: node.path,
      name: node.name,
      type: node.type,
      children,
    });
  }

  normalized.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return normalized;
};

export const getFuzzySubsequenceScore = (target: string, query: string): number => {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;

  for (let i = 0; i < target.length && queryIndex < query.length; i += 1) {
    if (target[i] === query[queryIndex]) {
      if (firstMatch === -1) firstMatch = i;
      lastMatch = i;
      queryIndex += 1;
    }
  }

  if (queryIndex !== query.length || firstMatch === -1 || lastMatch === -1) {
    return -1;
  }

  const span = lastMatch - firstMatch + 1;
  const compactnessBonus = Math.max(0, query.length * 10 - (span - query.length) * 2);
  const earlyMatchBonus = Math.max(0, 40 - firstMatch);
  return compactnessBonus + earlyMatchBonus;
};

export const scoreMentionCandidate = (entry: FlatFileNode, rawQuery: string): number => {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return entry.type === 'directory' ? 12 : 10;
  }

  const pathLower = entry.path.toLowerCase();
  const nameLower = entry.name.toLowerCase();

  if (nameLower === query) return 2000;
  if (pathLower === query) return 1950;

  if (nameLower.startsWith(query)) {
    return 1700 - Math.min(nameLower.length - query.length, 200);
  }

  const nameIndex = nameLower.indexOf(query);
  if (nameIndex >= 0) {
    return 1500 - Math.min(nameIndex, 400);
  }

  const pathIndex = pathLower.indexOf(query);
  if (pathIndex >= 0) {
    return 1300 - Math.min(pathIndex, 500);
  }

  const queryParts = query.split(/[\\/\s._-]+/).filter(Boolean);
  if (queryParts.length > 1 && queryParts.every((part) => pathLower.includes(part))) {
    return 1100 - queryParts.length;
  }

  const nameFuzzyScore = getFuzzySubsequenceScore(nameLower, query);
  if (nameFuzzyScore >= 0) {
    return 900 + nameFuzzyScore;
  }

  const pathFuzzyScore = getFuzzySubsequenceScore(pathLower, query);
  if (pathFuzzyScore >= 0) {
    return 700 + pathFuzzyScore;
  }

  return -1;
};

export const extractText = (payload: unknown): string => {
  if (!payload) return '';

  if (typeof payload === 'string') {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => extractText(item)).filter(Boolean).join('\n');
  }

  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;

    if (typeof record.text === 'string') {
      return record.text;
    }

    if (typeof record.content === 'string') {
      return record.content;
    }

    if (Array.isArray(record.content)) {
      return extractText(record.content);
    }

    if (record.message) {
      return extractText(record.message);
    }

    if (record.delta) {
      return extractText(record.delta);
    }

    if (record.output) {
      return extractText(record.output);
    }
  }

  return '';
};

export const stripKnownXmlArtifacts = (value: string): string => {
  return value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/gi, '$1')
    .replace(/<command-message>([\s\S]*?)<\/command-message>/gi, '$1')
    .replace(/<command-args>([\s\S]*?)<\/command-args>/gi, '$1')
    .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/gi, '$1');
};

export const normalizeDisplayText = (payload: unknown): string => {
  const raw = extractText(payload);
  if (!raw) return '';
  return stripKnownXmlArtifacts(raw)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const shouldSkipNoisyMessage = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    normalized === 'exit' ||
    normalized === 'bye!' ||
    normalized === 'goodbye!' ||
    normalized.startsWith('caveat:') ||
    normalized.startsWith('this session is being continued from a previous') ||
    normalized.startsWith('invalid api key')
  );
};

export const toToolResultPreview = (payload: unknown): string => {
  const cleaned = normalizeDisplayText(payload);
  if (!cleaned) {
    return '';
  }
  if (cleaned.length <= MAX_TOOL_RESULT_PREVIEW_CHARS) {
    return cleaned;
  }
  const hiddenChars = cleaned.length - MAX_TOOL_RESULT_PREVIEW_CHARS;
  return `${cleaned.slice(0, MAX_TOOL_RESULT_PREVIEW_CHARS)}\n[...truncated ${hiddenChars} chars]`;
};

export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const stripReferencedMentions = (text: string, referencedPaths: string[]): string => {
  if (!text) return '';
  if (!referencedPaths.length) return text.trim();

  let output = text;
  for (const filePath of referencedPaths) {
    const mentionPattern = new RegExp(`(^|\\s)@${escapeRegex(filePath)}(?=\\s|$)`, 'g');
    output = output.replace(mentionPattern, '$1');
  }

  return output
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const stripEmbeddedFileContext = (text: string): string => {
  if (!text) return '';
  const markerCandidates = ['\n\nReferenced paths:\n', '\n\nReferenced files:\n'];
  const markerIndex = markerCandidates
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? -1;
  if (markerIndex === -1) {
    return text.trim();
  }
  return text.slice(0, markerIndex).trim();
};

export const isListItemLine = (line: string): boolean => /^(\s*)([-*+]|\d+\.)\s+/.test(line.trimStart());

export const compactMessageText = (text: string): string => {
  if (!text) return '';

  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const compacted: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/[ \t]+$/g, '');
    const trimmed = line.trim();

    if (!trimmed) {
      const prevLine = compacted[compacted.length - 1] || '';
      const nextLine = lines.slice(i + 1).find((value) => value.trim().length > 0) || '';

      if (!prevLine.trim()) {
        continue;
      }

      // Keep list blocks tight: remove empty lines around list items.
      if (isListItemLine(prevLine) || isListItemLine(nextLine)) {
        continue;
      }

      compacted.push('');
      continue;
    }

    compacted.push(line);
  }

  return compacted.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

export const shouldRenderAsPreformatted = (text: string): boolean => {
  if (!text) return false;
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;

  const markdownTableLines = lines.filter((line) => line.includes('|')).length;
  if (markdownTableLines >= 2) return false;

  const boxDrawingLines = lines.filter((line) => /[閳瑰备鏁╅埞鎰ㄦ晜閳圭补鏁囬埞鍌楁敘]/.test(line)).length;
  if (boxDrawingLines >= 2) return true;

  const alignedColumnLines = lines.filter((line) => /\S(?: {2,}|\t)\S/.test(line)).length;
  return alignedColumnLines >= 3;
};

export const getProviderMessageType = (provider: SessionProvider): string => {
  if (provider === 'codex') return 'codex-command';
  return 'claude-command';
};

export const getStorageKeyForModel = (provider: SessionProvider): string => `chat-model-${provider}`;

export const getProviderDisplayName = (provider: SessionProvider): string => {
  if (provider === 'codex') return 'OpenAI Codex';
  return 'Claude';
};

export const getCodexPermissionMode = (): string => {
  try {
    const raw = localStorage.getItem('codex-settings');
    if (!raw) return 'default';
    const parsed = JSON.parse(raw);
    return parsed?.permissionMode || 'default';
  } catch {
    return 'default';
  }
};

export const normalizeLaunchArgs = (rawArgs: unknown): string[] => {
  if (!Array.isArray(rawArgs)) {
    return [];
  }

  return rawArgs
    .map((arg) => (typeof arg === 'string' ? arg.trim() : ''))
    .filter((arg) => arg.length > 0);
};

export const getSessionLaunchArgs = (
  session: ProjectSession | null,
  provider: SessionProvider,
): string[] => {
  const explicitArgs = normalizeLaunchArgs(session?.__launchArgs);
  if (explicitArgs.length > 0) {
    return explicitArgs;
  }

  if (provider !== 'claude' && provider !== 'codex') {
    return [];
  }

  const providerProfiles = loadSessionLaunchProfilesByProvider(provider);
  const explicitProfileId = typeof session?.__launchProfileId === 'string'
    ? session.__launchProfileId
    : '';
  const fallbackProfileId = explicitProfileId || providerProfiles.defaultProfileId;
  if (!fallbackProfileId) {
    return [];
  }

  return mergeSessionLaunchArgs(providerProfiles.profiles, fallbackProfileId, []);
};

export const hasBypassLaunchArgs = (session: ProjectSession | null, provider?: SessionProvider): boolean => {
  const launchArgs = provider ? getSessionLaunchArgs(session, provider) : normalizeLaunchArgs(session?.__launchArgs);
  return launchArgs.some((arg) => BYPASS_PERMISSION_FLAGS.has(arg.trim().toLowerCase()));
};

export const inferCodexPermissionModeFromSession = (session: ProjectSession | null): string => {
  const permissionModeHint = typeof session?.permissionModeHint === 'string'
    ? session.permissionModeHint
    : '';
  if (permissionModeHint === 'bypassPermissions' || permissionModeHint === 'acceptEdits' || permissionModeHint === 'default') {
    return permissionModeHint;
  }

  const approvalPolicy = typeof session?.approvalPolicy === 'string'
    ? session.approvalPolicy.trim().toLowerCase()
    : '';
  const sandboxType = typeof session?.sandboxType === 'string'
    ? session.sandboxType.trim().toLowerCase()
    : '';

  if (approvalPolicy === 'never' || sandboxType === 'danger-full-access') {
    return 'bypassPermissions';
  }

  if (approvalPolicy || sandboxType) {
    return 'acceptEdits';
  }

  return getCodexPermissionMode();
};

export const getInitialProvider = (): SessionProvider => {
  const saved = localStorage.getItem('selected-provider');
  if (saved === 'codex') return 'codex';
  return 'claude';
};

export const inferProviderFromProjectSession = (
  sessionId: string | null | undefined,
  project: Project,
): SessionProvider | null => {
  if (!sessionId) {
    return null;
  }

  if ((project.codexSessions || []).some((session) => session.id === sessionId)) {
    return 'codex';
  }
  if ((project.sessions || []).some((session) => session.id === sessionId)) {
    return 'claude';
  }
  return null;
};
