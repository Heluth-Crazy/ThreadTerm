import { describe, expect, it } from 'vitest';
import {
  buildSettingsBundleDiff,
  createSettingsBundle,
  getDefaultSelectedSettingsSections,
  getSettingsBundleExportFilename,
  parseSettingsBundle,
  stringifySettingsBundle,
} from './settingsBundle';
import type { ThemePack } from '../../theme/themeTypes';

const appTokens = {
  background: '#ffffff',
  foreground: '#111827',
  card: '#f9fafb',
  cardForeground: '#111827',
  popover: '#ffffff',
  popoverForeground: '#111827',
  primary: '#2563eb',
  primaryForeground: '#ffffff',
  secondary: '#e5e7eb',
  secondaryForeground: '#111827',
  muted: '#f3f4f6',
  mutedForeground: '#4b5563',
  accent: '#dbeafe',
  accentForeground: '#1e3a8a',
  destructive: '#dc2626',
  destructiveForeground: '#ffffff',
  border: '#d1d5db',
  input: '#d1d5db',
  ring: '#2563eb',
};

const terminalTokens = {
  background: '#111827',
  foreground: '#f9fafb',
  cursor: '#f9fafb',
  cursorAccent: '#111827',
  selection: '#374151',
  selectionForeground: '#f9fafb',
  black: '#111827',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

const customTheme: ThemePack = {
  id: 'custom:portable',
  name: 'Portable',
  description: 'Portable test theme.',
  attribution: {
    kind: 'original',
    sourceName: 'Local',
    sourceUrl: '',
  },
  isCustom: true,
  modes: {
    light: {
      app: appTokens,
      terminal: terminalTokens,
    },
  },
};

describe('settings bundle', () => {
  it('exports only whitelisted fields and never leaks sensitive store data', () => {
    const bundle = createSettingsBundle({
      exportedAt: '2026-05-04T00:00:00.000Z',
      themePreference: {
        themeMode: 'dark',
        themePackId: 'custom:portable',
        bridgeToken: 'bridge-token-secret',
      } as never,
      customThemePacks: [
        {
          ...customTheme,
          providerKey: 'provider-key-secret',
        } as never,
      ],
      terminalSettings: {
        bottomBarHidden: true,
        aiExplainDefaultProvider: 'codex',
        osNotificationsEnabled: true,
        notificationMode: 'both',
        petSecret: 'pet-secret',
        cards: [{ providerSessionId: 'provider-session-secret' }],
        pairedDevices: [{ id: 'device-secret' }],
      } as never,
      overlaySettings: {
        selectorMode: 'carousel',
        hotkeyA: 'CmdOrCtrl+Shift+A',
        hotkeyB: 'CmdOrCtrl+Shift+B',
        floatCardId: 'card-secret',
      } as never,
    });

    const json = stringifySettingsBundle(bundle);

    expect(json).toContain('"app": "ThreadTerm"');
    expect(json).not.toContain('bridge-token-secret');
    expect(json).not.toContain('provider-key-secret');
    expect(json).not.toContain('provider-session-secret');
    expect(json).not.toContain('device-secret');
    expect(json).not.toContain('pet-secret');
    expect(json).not.toContain('card-secret');
    expect(json).not.toContain('audit-secret');
    expect(bundle.sections.terminal?.osNotificationsEnabled).toBe(true);
  });

  it('parses a bundle and normalizes custom themes to portable ids', () => {
    const json = stringifySettingsBundle(
      createSettingsBundle({
        customThemePacks: [customTheme],
      }),
    );

    const parsed = parseSettingsBundle(json);

    expect(parsed.kind).toBe('success');
    if (parsed.kind === 'success') {
      expect(parsed.bundle.sections.customThemes?.packs[0]?.id).toBe('portable');
      expect(parsed.bundle.sections.customThemes?.packs[0]?.isCustom).toBeUndefined();
    }
  });

  it('ignores removed workflow sections from older settings bundles', () => {
    const parsed = parseSettingsBundle(JSON.stringify({
      app: 'ThreadTerm',
      kind: 'threadterm-settings-bundle',
      schemaVersion: 1,
      exportedAt: '2026-05-04T00:00:00.000Z',
      sections: {
        workflows: {
          global: [{ fileName: '../secret.yaml', yamlText: 'name: Bad\ncommand: bad\n' }],
        },
      },
    }));

    expect(parsed.kind).toBe('success');
    if (parsed.kind === 'success') {
      expect(parsed.bundle.sections).not.toHaveProperty('workflows');
    }
  });

  it('builds section diffs and selects only changed sections by default', () => {
    const current = createSettingsBundle({
      themePreference: { themeMode: 'system', themePackId: 'threadterm-default' },
      terminalSettings: { bottomBarHidden: false, aiExplainDefaultProvider: 'claude' },
    });
    const incoming = createSettingsBundle({
      themePreference: { themeMode: 'system', themePackId: 'threadterm-default' },
      terminalSettings: { bottomBarHidden: true, aiExplainDefaultProvider: 'gemini' },
    });

    const diffs = buildSettingsBundleDiff(current, incoming);

    expect(diffs.find((diff) => diff.id === 'theme')?.status).toBe('unchanged');
    expect(diffs.find((diff) => diff.id === 'terminal')?.status).toBe('changed');
    expect(getDefaultSelectedSettingsSections(diffs)).toContain('terminal');
    expect(getDefaultSelectedSettingsSections(diffs)).not.toContain('theme');
  });

  it('uses stable dated filenames', () => {
    expect(getSettingsBundleExportFilename(new Date('2026-05-04T12:00:00Z'))).toBe(
      'threadterm-settings-2026-05-04.threadterm-settings.json',
    );
  });
});
