import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type TauriConfig = {
  app?: {
    security?: {
      csp?: string;
      devCsp?: string;
    };
  };
};

function loadTauriConfig(fileName: string): TauriConfig {
  const configPath = resolve(process.cwd(), "src-tauri", fileName);
  return JSON.parse(readFileSync(configPath, "utf8")) as TauriConfig;
}

function loadTauriSecurityConfig(fileName = "tauri.conf.json") {
  const config = loadTauriConfig(fileName);

  return config.app?.security ?? {};
}

function mergeTauriConfig(
  base: TauriConfig,
  override: TauriConfig,
): TauriConfig {
  return {
    ...base,
    ...override,
    app: {
      ...base.app,
      ...override.app,
      security: {
        ...base.app?.security,
        ...override.app?.security,
      },
    },
  };
}

function directive(policy: string | undefined, name: string): string {
  return (
    policy
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `)) ?? ""
  );
}

describe("Tauri CSP config", () => {
  it("keeps production script CSP strict while allowing Vite React refresh in dev", () => {
    const { csp, devCsp } = loadTauriSecurityConfig();

    expect(directive(csp, "script-src")).toBe("script-src 'self'");
    expect(directive(devCsp, "script-src")).toBe(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(devCsp).toContain("ws://localhost:*");
    expect(devCsp).toContain("ws://127.0.0.1:*");
  });

  it("allows asset protocol and local dev HTML preview frames", () => {
    const { csp, devCsp } = loadTauriSecurityConfig();

    expect(directive(csp, "frame-src")).toBe(
      "frame-src blob: http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* asset: http://asset.localhost",
    );
    expect(directive(devCsp, "frame-src")).toBe(
      "frame-src blob: http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* asset: http://asset.localhost",
    );
  });

  it("allows asset protocol and remote images for file previews", () => {
    const { csp, devCsp } = loadTauriSecurityConfig();

    expect(directive(csp, "img-src")).toBe(
      "img-src 'self' data: blob: asset: http://asset.localhost https:",
    );
    expect(directive(devCsp, "img-src")).toBe(
      "img-src 'self' data: blob: asset: http://asset.localhost https:",
    );
  });

  it("overrides the production CSP with an offline WebDriver policy", () => {
    const production = loadTauriConfig("tauri.conf.json");
    const harness = loadTauriConfig("tauri.webdriver.conf.json");
    const merged = mergeTauriConfig(production, harness);
    const security = merged.app?.security ?? {};
    const csp = security.csp;
    const devCsp = security.devCsp;

    expect(csp).toBe(harness.app?.security?.csp);
    expect(devCsp).toBe(harness.app?.security?.devCsp);
    expect(csp).toBe(devCsp);

    for (const policy of [csp, devCsp]) {
      expect(directive(policy, "style-src")).toBe(
        "style-src 'self' 'unsafe-inline'",
      );
      expect(directive(policy, "font-src")).toBe("font-src 'self' data:");
      expect(directive(policy, "img-src")).toBe(
        "img-src 'self' data: blob: asset: http://asset.localhost",
      );
      expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
      expect(directive(policy, "frame-src")).toBe(
        "frame-src 'self' blob: asset: http://asset.localhost",
      );
      expect(policy).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/i);
      expect(policy).not.toMatch(/\bhttps:/i);
      expect(policy).not.toMatch(/\bhttps?:\/\/(?!asset\.localhost(?:\b|\/))/i);
    }
  });
});
