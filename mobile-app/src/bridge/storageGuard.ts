/**
 * Guards against persisting source code, diffs, drafts, or terminal output
 * on the mobile device. Only non-sensitive metadata and UI preferences may
 * be written to localStorage / sessionStorage / IndexedDB / Tauri store.
 */

const FORBIDDEN_KEY_PATTERNS = [
  /source/i,
  /file.?content/i,
  /draft/i,
  /diff/i,
  /terminal.?output/i,
  /pty.?buffer/i,
  /editor.?text/i,
  /unsynced/i,
  /workspace.?body/i,
];

const ALLOWED_KEY_PREFIXES = [
  'threadterm.mobile.',
  'threadterm.bridge',
  // legacy pairing keys (token only in sessionStorage by design)
  'threadterm.bridgeToken',
  'threadterm.bridgePermission',
  'threadterm.bridgeServerId',
];

export interface StorageAuditFinding {
  key: string;
  storage: 'localStorage' | 'sessionStorage';
  reason: string;
}

export function isAllowedPreferenceKey(key: string): boolean {
  if (FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
    // Explicit allow for non-content keys that mention "terminal" etc.
    if (
      key === 'threadterm.mobile.languagePreference' ||
      key === 'threadterm.mobile.themePreference' ||
      key === 'threadterm.mobile.deviceName'
    ) {
      return true;
    }
    return false;
  }
  return ALLOWED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix) || key === prefix);
}

/**
 * Reject attempts to persist payload bodies. Call before any write of
 * editor/diff/terminal content.
 */
export function assertNoSourcePersistence(
  key: string,
  value: string,
  options: { allowSessionToken?: boolean } = {},
): void {
  if (!isAllowedPreferenceKey(key)) {
    throw new Error(`Refusing to persist untrusted key "${key}" on mobile storage.`);
  }
  if (options.allowSessionToken && key.includes('Token')) {
    // session-scoped legacy token only; still never store file bodies.
    if (looksLikeSourcePayload(value)) {
      throw new Error('Refusing to persist source-like payload under token key.');
    }
    return;
  }
  if (looksLikeSourcePayload(value)) {
    throw new Error(`Refusing to persist source-like payload for key "${key}".`);
  }
}

export function looksLikeSourcePayload(value: string): boolean {
  if (!value) return false;
  // Strong markers first (may be short samples in tests / conflict previews).
  if (/^diff --git /m.test(value)) return true;
  if (/^<<<<<<< /m.test(value) || /^>>>>>>> /m.test(value)) return true;
  if (value.length < 40) return false;
  // Heuristics: multi-line code-ish bodies, not short preference tokens.
  const lines = value.split('\n');
  if (lines.length >= 4 && value.length >= 80) return true;
  if (/^(import |export |function |class |const |let |var )/m.test(value) && lines.length >= 3) {
    return true;
  }
  return false;
}

/** Scan browser storage for accidental source persistence (tests / diagnostics). */
export function auditBrowserStorage(
  localStorageImpl: Storage = window.localStorage,
  sessionStorageImpl: Storage = window.sessionStorage,
): StorageAuditFinding[] {
  const findings: StorageAuditFinding[] = [];
  const scan = (storage: Storage, name: 'localStorage' | 'sessionStorage') => {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key) continue;
      const value = storage.getItem(key) ?? '';
      if (!isAllowedPreferenceKey(key)) {
        findings.push({
          key,
          storage: name,
          reason: 'key not in allow-list for mobile preference storage',
        });
      } else if (looksLikeSourcePayload(value)) {
        findings.push({
          key,
          storage: name,
          reason: 'value looks like source, diff, or multi-line draft content',
        });
      }
    }
  };
  scan(localStorageImpl, 'localStorage');
  scan(sessionStorageImpl, 'sessionStorage');
  return findings;
}
