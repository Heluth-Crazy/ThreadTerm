import assert from "node:assert/strict";
import test from "node:test";
import type { DetectedRunEntry, Session, SessionRun } from "@threadterm/protocol";
import { activeRun, dependencyOptionIds, detectedSections, detectedSourceLabel, missingToolLabel, packageScripts, previewReady, previewWaitingLabel, quickLaunchError, runState, runStateLabel, suggestedLabel, suggestedTag, suggestedTitle } from "./quickLaunch";

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
  const errors: Record<string, [string, string]> = { revision_conflict: ["changed elsewhere", "其他窗口"], command_not_found: ["no longer exists", "不存在"], too_many_commands: ["up to 100", "最多保存 100"], cmd_single_line: ["one line", "仅执行一行"], shell_unavailable: ["not installed", "未安装"], cwd_outside_root: ["inside this worktree", "工作树内"], cwd_missing: ["does not exist", "不存在"], package_scripts_invalid: ["Invalid package.json", "package.json 无效"], no_package_scripts: ["No scripts", "没有脚本"], no_package_json: ["No package.json", "没有 package.json"], invalid_env: ["environment names", "环境变量名称"], invalid_preview_url: ["http://", "http://"], nested_depends_on:["cannot have dependencies","不能再包含依赖"], invalid_depends_on:["without cycles","没有循环"], dependency_failed:["dependency failed","依赖启动失败"], port_unavailable:["port could not be allocated","无法为此命令分配"], command_has_dependents:["required by other saved commands","其他已保存命令依赖"] };
  for (const [code, [en, zh]] of Object.entries(errors)) { assert.match(quickLaunchError(new Error(code), false), new RegExp(en)); assert.match(quickLaunchError(new Error(code), true), new RegExp(zh)); }
  assert.equal(quickLaunchError(new Error('dependency_failed: db'), false), 'Dependency failed: db');
  assert.equal(quickLaunchError(new Error('dependency_failed: db'), true), '依赖失败：db');
  assert.equal(quickLaunchError(new Error('command_has_dependents: API, Web'), false), 'Cannot delete this command because it is required by: API, Web');
  assert.equal(quickLaunchError(new Error('command_has_dependents: API, Web'), true), '无法删除此命令，因为以下命令依赖它：API, Web');
});

test("dependency choices retain a missing saved id so an editor can remove it", () => {
  const catalog = [
    { id: "api", projectId: "p", revision: 1, name: "API", command: "node api", shell: "cmd" as const, cwd: "", kind: "service" as const, env: [], createdAt: "now", updatedAt: "now" },
    { id: "web", projectId: "p", revision: 1, name: "Web", command: "node web", shell: "cmd" as const, cwd: "", kind: "service" as const, env: [], createdAt: "now", updatedAt: "now" },
  ];
  assert.deepEqual(dependencyOptionIds(catalog, ["missing-db", "api"], "web"), ["api", "missing-db"]);
});

test("runState reports readiness for service runs and leaves tasks alone", () => {
  const service = { commandId: "dev", name: "Dev", kind: "service" as const, shell: "cmd" as const };
  // Watched: Starting while the process runs, however healthy its status looks.
  for (const status of ["running", "idle", "waiting"] as const) assert.equal(runState(session({ status, run: { ...service, readiness: "waiting" } })).state, "starting", status);
  // Ready, and it says which port when the port is the address.
  const ready = runState(session({ status: "running", run: { ...service, readiness: "ready", urlSource: "port", port: 5173 } }));
  assert.equal(ready.state, "ready");
  assert.equal(ready.port, 5173);
  // No answer, or an older run: Running, as before readiness existed.
  assert.equal(runState(session({ status: "running", run: { ...service, readiness: "none" } })).state, "running");
  assert.equal(runState(session({ status: "running", run: service })).state, "running");
  assert.equal(runState(session({ status: "running", run: { ...service, readiness: "none", port: 5173 } })).port, undefined, "a port is only shown while ready");
  assert.equal(runState(session({ status: "running", run: { ...service, readiness: "waiting", allocatedPort: 43123 } })).port, 43123, "an allocation is shown before readiness");
  // A port is shown only while it is the run's address: a printed URL that replaced it never shows it.
  assert.equal(runState(session({ status: "running", run: { ...service, readiness: "ready", urlSource: "port", port: 5173 } })).port, 5173);
  assert.equal(runState(session({ status: "running", run: { ...service, readiness: "ready", urlSource: "output", url: "http://localhost:3000/", port: 5173 } })).port, undefined, "the printed address wins, so no :port");
  assert.equal(runState(session({ status: "running", run: { ...service, readiness: "ready", port: 5173 } })).port, undefined, "no urlSource, no port");
  // Tasks are untouched by readiness.
  const task = { ...service, kind: "task" as const };
  for (const readiness of ["waiting", "ready", "none"] as const) assert.equal(runState(session({ status: "running", run: { ...task, readiness } })).state, "running", readiness);
  // An end still wins over readiness.
  assert.equal(runState(session({ status: "exited", exitCode: 0, run: { ...service, readiness: "ready" } })).state, "exited");
  assert.equal(runState(session({ status: "error", run: { ...service, readiness: "waiting" } })).state, "failed");
});

test("the Ready label is localized and Open Preview waits for readiness", () => {
  assert.equal(runStateLabel({ state: "ready" }, false), "Ready");
  assert.equal(runStateLabel({ state: "ready" }, true), "已就绪");
  assert.equal(previewWaitingLabel(false), "Waiting for the server to listen…");
  assert.equal(previewWaitingLabel(true), "等待服务开始监听…");
  const live = (run: Partial<SessionRun>, status: Session["status"] = "running"): Session => ({ id: "run-1", title: "Dev", provider: "custom", mode: "terminal", status, createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z", worktreePath: "C:\\repo", run: { commandId: "dev", name: "Dev", kind: "service", shell: "cmd", ...run } });
  // Open once ready, once the watcher gave up, for runs without readiness, and for a printed URL.
  assert.equal(previewReady(live({ readiness: "ready", urlSource: "port" })), true);
  assert.equal(previewReady(live({ readiness: "none", urlSource: "configured" })), true);
  assert.equal(previewReady(live({ urlSource: "configured" })), true);
  assert.equal(previewReady(live({ readiness: "waiting", urlSource: "output" })), true);
  assert.equal(previewReady(live({ readiness: "waiting", urlSource: "output", allocatedPort: 43123 })), false, "an allocated port must listen even when output printed a URL");
  assert.equal(previewReady(live({ readiness: "ready", urlSource: "output", allocatedPort: 43123 })), true);
  // Only a still-watching run's own configured fallback waits…
  assert.equal(previewReady(live({ readiness: "waiting", urlSource: "configured" })), false);
  // …and a run whose session already ended never waits, even if its watcher never settled.
  for (const status of ["exited", "interrupted", "error"] as const) assert.equal(previewReady(live({ readiness: "waiting", urlSource: "configured" }, status)), true, status);
  assert.equal(previewReady({ status: "running" }), false, "no run, no preview");
  assert.equal(previewReady(undefined), false);
});

const detectedEntry = (overrides: Partial<DetectedRunEntry> = {}): DetectedRunEntry => ({ key: "node:package.json:dev", source: { kind: "node", file: "package.json", label: "package.json" }, name: "dev", command: "npm run dev", shell: "cmd", cwd: "", kind: "service", group: "demo", ...overrides });

test("detectedSections groups by source then manifest group in a fixed order", () => {
  const web = { kind: "node" as const, file: "apps/web/package.json", label: "package.json" };
  const entries = [
    detectedEntry({ key: "make:Makefile:build", source: { kind: "make", file: "Makefile", label: "Makefile" }, group: "Makefile", command: "make build", kind: "task" }),
    detectedEntry({ key: "node:apps/web/package.json:build", source: web, group: "@acme/web", cwd: "apps/web", kind: "task" }),
    detectedEntry(),
    detectedEntry({ key: "cargo:crates/api:test", source: { kind: "cargo", file: "crates/api/Cargo.toml", label: "Cargo.toml" }, group: "api", command: "cargo test -p api", kind: "task" }),
    detectedEntry({ key: "node:apps/web/package.json:dev", source: web, group: "@acme/web", cwd: "apps/web" }),
  ];
  const sections = detectedSections(entries);
  assert.deepEqual(sections.map(section => section.kind), ["node", "cargo", "make"]);
  assert.deepEqual(sections[0].groups.map(group => group.name), ["@acme/web", "demo"]);
  assert.deepEqual(sections[0].groups[0].entries.map(entry => entry.key), ["node:apps/web/package.json:build", "node:apps/web/package.json:dev"]);
  assert.deepEqual(sections[1].groups.map(group => group.entries[0].key), ["cargo:crates/api:test"]);
  assert.deepEqual(detectedSections([]), []);
  // A source without a package name still groups, by its manifest label.
  assert.equal(detectedSections([detectedEntry({ group: "" })])[0].groups[0].name, "package.json");
});

test("detected source labels, missing-tool copy and errors are localized", () => {
  for (const kind of ["node", "cargo", "maven", "gradle", "python", "make", "just", "compose", "procfile"] as const) {
    assert.ok(detectedSourceLabel(kind, false).length > 0 && detectedSourceLabel(kind, true).length > 0);
  }
  assert.equal(detectedSourceLabel("node", false), "Node scripts");
  assert.equal(detectedSourceLabel("node", true), "Node 脚本");
  assert.equal(detectedSourceLabel("maven", false), "Maven");
  assert.equal(detectedSourceLabel("gradle", true), "Gradle");
  assert.equal(detectedSourceLabel("python", false), "Python");
  assert.equal(missingToolLabel("make", false), "make isn't on PATH");
  assert.equal(missingToolLabel("make", true), "PATH 中找不到 make");
  assert.equal(suggestedLabel(false), "Suggested");
  assert.equal(suggestedLabel(true), "建议");
  assert.equal(suggestedTitle(false), "Found in source code; check the command before saving.");
  assert.equal(suggestedTitle(true), "根据源代码推断；保存前请检查命令。");
  assert.match(quickLaunchError(new Error("detected_entry_not_found"), false), /no longer exists/);
  assert.match(quickLaunchError(new Error("detected_entry_not_found"), true), /已不存在/);
  assert.match(quickLaunchError(new Error("tool_not_found: make"), false), /not on PATH/);
  assert.match(quickLaunchError(new Error("tool_not_found: make"), true), /PATH/);
});

test("detectedSections orders the JVM and Python kinds between Cargo and Makefile", () => {
  const entry = (kind: DetectedRunEntry["source"]["kind"], file: string): DetectedRunEntry => detectedEntry({ key: `${kind}:${file}:test`, source: { kind, file, label: file }, group: file });
  const entries = [entry("procfile", "Procfile"), entry("python", "pyproject.toml"), entry("gradle", "build.gradle"), entry("maven", "pom.xml"), entry("cargo", "Cargo.toml"), entry("node", "package.json")];
  assert.deepEqual(detectedSections(entries).map(section => section.kind), ["node", "cargo", "maven", "gradle", "python", "procfile"]);
  assert.deepEqual(detectedSections([entry("python", "pyproject.toml")])[0].groups.map(group => group.name), ["pyproject.toml"]);
  // The tag itself is decided by the production helper the row uses, not by the fixture.
  const suggested = suggestedTag(detectedEntry({ suggested: true }), false);
  assert.deepEqual(suggested, { label: "Suggested", title: "Found in source code; check the command before saving." });
  assert.deepEqual(suggestedTag({ suggested: true }, true), { label: "建议", title: "根据源代码推断；保存前请检查命令。" });
  assert.equal(suggestedTag(detectedEntry(), false), undefined, "a manifest entry shows no tag");
  assert.equal(suggestedTag({ suggested: false }, false), undefined);
  assert.equal(suggestedTag(undefined, false), undefined, "a saved row has no detected entry");
});
