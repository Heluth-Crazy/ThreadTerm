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

  it('allows asset protocol and local dev HTML preview frames', () => {
    const { csp, devCsp } = loadTauriSecurityConfig();

    expect(directive(csp, 'frame-src')).toBe(
      'frame-src blob: http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* asset: http://asset.localhost',
    );
    expect(directive(devCsp, 'frame-src')).toBe(
      'frame-src blob: http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* asset: http://asset.localhost',
    );
  });

  it('allows asset protocol and remote images for file previews', () => {
    const { csp, devCsp } = loadTauriSecurityConfig();

    expect(directive(csp, 'img-src')).toBe(
      "img-src 'self' data: blob: asset: http://asset.localhost https:",
    );
    expect(directive(devCsp, 'img-src')).toBe(
      "img-src 'self' data: blob: asset: http://asset.localhost https:",
    );
  });
});
