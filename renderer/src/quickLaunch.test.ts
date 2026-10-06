import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "@threadterm/protocol";
import { activeRun, packageScripts, quickLaunchError, runState, runStateLabel } from "./quickLaunch";

const session = (overrides: Partial<Session> = {}): Session => ({ id: "run-1", title: "Dev", provider: "custom", mode: "terminal", status: "exited", createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z", worktreePath: "C:\\repo", run: { commandId: "dev", name: "Dev", kind: "service", shell: "cmd" }, ...overrides });

test("runState exhaustively maps status, kind, exit code, and stop intent", () => {
  const service = { commandId: "dev", name: "Dev", kind: "service" as const, shell: "cmd" as const }, task = { ...service, kind: "task" as const };
  for (const status of ["starting", "running", "idle", "waiting"] as const) for (const stopRequested of [false, true]) for (const exitCode of [undefined, 0, 3]) assert.equal(runState(session({ status, exitCode, run: { ...service, stopRequested } })).state, status === "starting" ? "starting" : "running", `${status}/${exitCode}/${stopRequested}`);
  for (const kind of [service, task]) for (const exitCode of [undefined, 0, 3]) assert.equal(runState(session({ status: "exited", exitCode, run: kind })).state, exitCode === 3 ? "failed" : exitCode === 0 && kind.kind === "task" ? "completed" : "exited", `exited/${kind.kind}/${exitCode}`);
  for (const status of ["exited", "interrupted", "error"] as const) assert.equal(runState(session({ status, exitCode: 3, run: { ...service, stopRequested: true } })).state, "stopped", `${status}/stopped`);
  assert.equal(runState(session({ status: "interrupted", exitCode: 3 })).state, "interrupted");
  assert.equal(runState(session({ status: "error", exitCode: 0 })).state, "failed");
  const completed = runState(session({ status: "exited", exitCode: 0, run: { ...task, url: "http://localhost:5173" } }));
  assert.equal(completed.exitCode, 0); assert.equal(completed.url, "http://localhost:5173");
});

test("activeRun matches canonical Windows drive and UNC worktree roots", () => {
  const running = session({ status: "running", worktreePath: "\\\\?\\C:\\Repo\\worktree\\" });
  const unc = session({ id: "unc", status: "idle", worktreePath: "\\\\?\\UNC\\Server\\Share\\Repo", run: { commandId: "serve", name: "Serve", kind: "service", shell: "cmd" } });
  assert.equal(activeRun([running], "dev", "c:/repo/worktree"), running);
  assert.equal(activeRun([unc], "serve", "\\\\server\\share\\repo\\"), unc);
  assert.equal(activeRun([session({ status: "running", archived: true })], "dev", "C:\\repo"), undefined);
  assert.equal(activeRun([session({ status: "running", readOnly: true })], "dev", "C:\\repo"), undefined);
  assert.equal(activeRun([session({ status: "running", worktreePath: undefined })], "dev", "C:\\repo"), undefined);
  assert.equal(activeRun([session({ status: "running", run: { commandId: "other", name: "Other", kind: "service", shell: "cmd" } })], "dev", "C:\\repo"), undefined);
  assert.equal(activeRun([session({ status: "running", worktreePath: "C:\\other" })], "dev", "C:\\repo"), undefined);
  assert.equal(activeRun([session({ status: "exited" })], "dev", "C:\\repo"), undefined);
});

test("packageScripts selects the preferred manager and classifies scripts", () => {
  const json = JSON.stringify({ scripts: { dev: "vite", start: "node server", serve: "serve", preview: "vite preview", watch: "node watch", "watch:css": "tailwind", build: "tsc", test: "node --test", ignored: 1 } });
  const imported = packageScripts(json, ["C:\\repo\\package-lock.json", "C:\\repo\\bun.lockb", "C:\\repo\\yarn.lock", "C:\\repo\\pnpm-lock.yaml"]);
  assert.equal(imported.length, 8);
  assert.ok(!imported.some(script => script.name === "ignored"));
  assert.deepEqual(imported.slice(0, 6).map(({ name, command, kind }) => ({ name, command, kind })), [
    { name: "dev", command: "pnpm dev", kind: "service" }, { name: "start", command: "pnpm start", kind: "service" }, { name: "serve", command: "pnpm serve", kind: "service" }, { name: "preview", command: "pnpm preview", kind: "service" }, { name: "watch", command: "pnpm watch", kind: "service" }, { name: "watch:css", command: "pnpm watch:css", kind: "service" },
  ]);
  assert.deepEqual(packageScripts('{"scripts":{"build":"tsc"}}', ["yarn.lock"]), [{ name: "build", command: "yarn build", kind: "task" }]);
  assert.deepEqual(packageScripts('{"scripts":{"build":"tsc"}}', ["bun.lock"]), [{ name: "build", command: "bun run build", kind: "task" }]);
  assert.deepEqual(packageScripts('{"scripts":{"build":"tsc"}}', ["bun.lockb"]), [{ name: "build", command: "bun run build", kind: "task" }]);
  assert.deepEqual(packageScripts('{"scripts":{"build":"tsc"}}', []), [{ name: "build", command: "npm run build", kind: "task" }]);
});

test("packageScripts rejects malformed data and unsafe script names", () => {
  assert.throws(() => packageScripts("{", []), /package_scripts_invalid/);
  for (const json of ["null", "0", "[]", "\"scripts\""]) assert.throws(() => packageScripts(json, []), /package_scripts_invalid/);
  assert.throws(() => packageScripts("{}", []), /no_package_scripts/);
  assert.throws(() => packageScripts('{"scripts":null}', []), /no_package_scripts/);
  assert.throws(() => packageScripts('{"scripts":[]}', []), /no_package_scripts/);
  assert.throws(() => packageScripts('{"scripts":{"dev && whoami":"vite"}}', []), /package_scripts_invalid/);
});

test("Quick Launch labels and errors are localized", () => {
  const labels = { starting: ["Starting", "启动中"], running: ["Running", "运行中"], completed: ["Completed", "已完成"], exited: ["Exited", "已退出"], stopped: ["Stopped", "已停止"], interrupted: ["Interrupted", "已中断"] } as const;
  for (const [state, [en, zh]] of Object.entries(labels)) { assert.equal(runStateLabel({ state: state as keyof typeof labels }, false), en); assert.equal(runStateLabel({ state: state as keyof typeof labels }, true), zh); }
  assert.equal(runStateLabel({ state: "failed" }, false), "Failed to start"); assert.equal(runStateLabel({ state: "failed" }, true), "启动失败");
  assert.equal(runStateLabel({ state: "failed", exitCode: 3 }, false), "Failed (exit 3)"); assert.equal(runStateLabel({ state: "failed", exitCode: 3 }, true), "失败（退出码 3）");
  const errors: Record<string, [string, string]> = { revision_conflict: ["changed elsewhere", "其他窗口"], command_not_found: ["no longer exists", "不存在"], too_many_commands: ["up to 100", "最多保存 100"], cmd_single_line: ["one line", "仅执行一行"], shell_unavailable: ["not installed", "未安装"], cwd_outside_root: ["inside this worktree", "工作树内"], cwd_missing: ["does not exist", "不存在"], package_scripts_invalid: ["Invalid package.json", "package.json 无效"], no_package_scripts: ["No scripts", "没有脚本"], no_package_json: ["No package.json", "没有 package.json"], invalid_env: ["environment names", "环境变量名称"], invalid_preview_url: ["http://", "http://"] };
  for (const [code, [en, zh]] of Object.entries(errors)) { assert.match(quickLaunchError(new Error(code), false), new RegExp(en)); assert.match(quickLaunchError(new Error(code), true), new RegExp(zh)); }
});
