import { describe, expect, it } from 'vitest';
import {
  migrateLegacyKimiGrokCard,
  recognizeLegacyKimiGrokExecutable,
  rollbackKimiGrokTypeToCustom,
} from './kimiGrokMigration';

describe('kimi/grok legacy migration', () => {
  it('recognizes exact executable basenames only', () => {
    expect(recognizeLegacyKimiGrokExecutable('kimi')).toBe('kimi');
    expect(recognizeLegacyKimiGrokExecutable('kimi.exe --foo')).toBe('kimi');
    expect(recognizeLegacyKimiGrokExecutable('C:\\\\Tools\\\\grok.exe')).toBe('grok');
    expect(recognizeLegacyKimiGrokExecutable('"C:/bin/grok" --resume x')).toBe('grok');
  });

  it('rejects wrappers, pipes and ambiguous commands', () => {
    expect(recognizeLegacyKimiGrokExecutable('cmd /c kimi')).toBeNull();
    expect(recognizeLegacyKimiGrokExecutable('powershell -Command kimi')).toBeNull();
    expect(recognizeLegacyKimiGrokExecutable('kimi | tee log')).toBeNull();
    expect(recognizeLegacyKimiGrokExecutable('env FOO=1 kimi')).toBeNull();
    expect(recognizeLegacyKimiGrokExecutable('my-kimi')).toBeNull();
    expect(recognizeLegacyKimiGrokExecutable('grok-cli')).toBeNull();
  });

  it('migrates only terminalType and preserves command/PTY fields', () => {
    const card = {
      id: 'c1',
      ptyId: 'pty-live',
      terminalType: 'custom' as const,
      command: 'kimi --session keep',
      providerSessionState: undefined as undefined,
      projectName: 'same',
    };
    const migrated = migrateLegacyKimiGrokCard(card);
    expect(migrated.terminalType).toBe('kimi');
    expect(migrated.command).toBe('kimi --session keep');
    expect(migrated.ptyId).toBe('pty-live');
    expect(migrated.providerSessionState).toBe('unbound');
  });

  it('does not inherit an unsupported bound state from a legacy custom card', () => {
    const migrated = migrateLegacyKimiGrokCard({
      terminalType: 'custom' as const,
      command: 'grok --resume stale-id',
      providerSessionState: 'bound' as const,
    });
    expect(migrated.terminalType).toBe('grok');
    expect(migrated.command).toBe('grok --resume stale-id');
    expect(migrated.providerSessionState).toBe('unbound');
  });

  it('rolls kimi/grok types back to custom without rewriting commands', () => {
    expect(
      rollbackKimiGrokTypeToCustom({
        terminalType: 'grok' as const,
        command: 'grok --session-id abc',
      }),
    ).toEqual({
      terminalType: 'custom',
      command: 'grok --session-id abc',
    });
  });
});
