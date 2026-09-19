// Isolated Electron fixture for the Grok proxy settings card. It uses a fresh
// runtime data directory and never reads or writes the user's saved settings.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { _electron as electron } from "@playwright/test";

const scratch = await mkdtemp(join(tmpdir(), "threadterm-provider-network-"));
const out = join("qa", "results", `provider-network-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const runtimeBin = process.env.THREADTERM_V3_RUNTIME_BIN ?? resolve("runtime/target-qa/debug/threadterm-v3-runtime.exe");
const env = {
  ...process.env,
  THREADTERM_V3_DATA: join(scratch, "data"),
  THREADTERM_V3_USER_DATA: join(scratch, "profile"),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-v3-provider-network-${randomUUID()}`,
  THREADTERM_V3_RUNTIME: runtimeBin,
};
const report = { startedAt: new Date().toISOString(), screenshots: [], checks: [], passed: false };
let app;
let page;
const rpc = (method, params = {}) => page.evaluate(([name, values]) => window.threadterm.request(name, values), [method, params]);
const snapshot = () => rpc("runtime.snapshot", {});
const update = async (patch) => {
  const current = await snapshot();
  return rpc("settings.update", { patch, expectedRevision: current.settings.revision, operationId: randomUUID() });
};
async function capture(name, width, theme) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
  const file = `${name}-${theme}-${width}.png`;
  await page.screenshot({ path: join(out, file), fullPage: true });
  report.screenshots.push(file);
}

try {
  await Promise.all([mkdir(out, { recursive: true }), mkdir(join(scratch, "data")), mkdir(join(scratch, "profile"))]);
  app = await electron.launch({ args: [resolve(".")], env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await update({ language: "en" });
  await page.locator(".user-row").click();
  const accountMenu = page.getByLabel("Local account");
  await accountMenu.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "Tools", exact: true }).click();
  await dialog.getByText("Grok network & proxy", { exact: true }).waitFor();

  await capture("inherit", 1280, "light");
  await dialog.getByRole("radio", { name: /Use a custom proxy/ }).check();
  const proxy = dialog.locator("#grok-proxy-url");
  await proxy.fill("socks5://localhost:1080");
  await proxy.blur();
  await page.getByText("Use an HTTP or HTTPS address", { exact: false }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Save proxy settings" }).isDisabled(), false, "invalid values remain editable for correction");
  report.checks.push("inline invalid proxy feedback is visible");
  await capture("invalid", 1440, "light");

  await dialog.getByRole("button", { name: "Discard changes" }).click();
  assert.equal(await dialog.getByRole("radio", { name: /Use inherited environment/ }).isChecked(), true, "discard restores inherited draft");
  await dialog.getByRole("radio", { name: /Use a custom proxy/ }).check();
  await proxy.fill("http://draft.example:8080");
  await dialog.locator("#grok-no-proxy").fill("localhost,.example.test");
  await update({ theme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await proxy.inputValue(), "http://draft.example:8080", "unrelated settings updates retain a dirty proxy draft");
  await update({ providerNetwork: { grok: { mode: "custom", proxyUrl: "https://external.example:8443", noProxy: "localhost,internal.example" } } });
  await page.getByText("Saved Grok proxy settings changed elsewhere", { exact: false }).waitFor();
  assert.equal(await proxy.inputValue(), "http://draft.example:8080", "external proxy settings do not overwrite a dirty draft");
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  assert.equal(await proxy.inputValue(), "https://external.example:8443", "discard loads the newer saved proxy settings");
  await proxy.fill("http://proxy.example:8080");
  await dialog.locator("#grok-no-proxy").fill("localhost,.example.test");
  await dialog.getByRole("button", { name: "Save proxy settings" }).click();
  await page.getByText("Grok proxy settings saved", { exact: false }).waitFor();
  let current = await snapshot();
  assert.deepEqual(current.settings.providerNetwork?.grok, { mode: "custom", proxyUrl: "http://proxy.example:8080", noProxy: "localhost,.example.test" });
  report.checks.push("custom proxy save round-trips through settings.update");
  await capture("custom", 1440, "dark");
  report.checks.push("unrelated and external settings changes preserve dirty drafts until discard");

  await dialog.getByRole("radio", { name: /Use inherited environment/ }).check();
  await dialog.getByRole("button", { name: "Save proxy settings" }).click();
  current = await snapshot();
  assert.equal(current.settings.providerNetwork?.grok?.mode, "inherit");
  report.checks.push("inherit mode saves through settings.update");
  await capture("inherit", 1920, "dark");
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(out, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await rpc("runtime.shutdown", { operationId: randomUUID() }).catch(() => {});
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  report.completedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await rm(scratch, { recursive: true, force: true });
  console.log(JSON.stringify({ out, passed: report.passed, error: report.error }, null, 2));
}
