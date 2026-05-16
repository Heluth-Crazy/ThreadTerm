import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function loadTauriSecurityConfig() {
  const configPath = resolve(process.cwd(), 'src-tauri/tauri.conf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    app?: {
      security?: {
        csp?: string;
        devCsp?: string;
      };
    };
  };

  return config.app?.security ?? {};
}

function directive(policy: string | undefined, name: string): string {
  return (
    policy
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `)) ?? ''
  );
}

describe('Tauri CSP config', () => {
  it('keeps production script CSP strict while allowing Vite React refresh in dev', () => {
    const { csp, devCsp } = loadTauriSecurityConfig();

    expect(directive(csp, 'script-src')).toBe("script-src 'self'");
    expect(directive(devCsp, 'script-src')).toBe("script-src 'self' 'unsafe-inline'");
    expect(devCsp).toContain('ws://localhost:*');
    expect(devCsp).toContain('ws://127.0.0.1:*');
  });
});
