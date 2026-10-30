import type { DetectedRunEntry, DetectedRunSourceKind, QuickLaunchCommand, QuickLaunchKind, Session } from '@threadterm/protocol';
import { sameCanonicalScope } from './projectScope';
import { workbenchError } from './workbench/errors';

export type RunState = 'starting'|'ready'|'running'|'completed'|'exited'|'failed'|'stopped'|'interrupted';
export type RunView = { state: RunState; exitCode?: number; url?: string; port?: number };
export function runState(session: Pick<Session, 'status'|'exitCode'|'run'>): RunView {
 const { status, exitCode, run } = session;
 // A service run says what its readiness watcher knows: watched is Starting, listening is Ready,
 // and no answer at all stays Running, as every run did before readiness existed.
 const readiness = run?.kind === 'service' ? run.readiness : undefined;
 const state: RunState = status === 'starting' || (['running','idle','waiting'].includes(status) && readiness === 'waiting') ? 'starting' : ['running','idle','waiting'].includes(status) ? readiness === 'ready' ? 'ready' : 'running' : run?.stopRequested ? 'stopped' : status === 'interrupted' ? 'interrupted' : status === 'error' || (exitCode !== undefined && exitCode !== 0) ? 'failed' : exitCode === 0 && run?.kind === 'task' ? 'completed' : 'exited';
 // An allocated port is stable from launch onward; the readiness port remains the fallback for older runs.
 return { state, exitCode, url: run?.url, port: run?.allocatedPort ?? (readiness === 'ready' && run?.urlSource === 'port' ? run?.port : undefined) };
}
/** Open Preview waits only while a live run is still being watched on its own configured address.
 * A ready run, a run without readiness (older runs, tasks), one that printed its URL, and a run whose
 * session already ended are all open, so a dead run never keeps a disabled link. */
export function previewReady(session: Pick<Session, 'status'|'run'> | undefined): boolean {
 const run = session?.run;
 if (!run) return false;
 if (!['starting','running','idle','waiting'].includes(session!.status)) return true;
 // A `${port}` launch is ready only when its reserved port listens; printed URLs do not satisfy that contract.
 if (run.allocatedPort !== undefined && run.readiness === 'waiting') return false;
 return !(run.readiness === 'waiting' && run.urlSource === 'configured');
}
/** Why a run's preview link is disabled. */
export function previewWaitingLabel(zh: boolean): string {
 return zh ? '等待服务开始监听…' : 'Waiting for the server to listen…';
}
/** Copy shared by the editor and its small renderer helper test. */
export function portPlaceholderHint(zh: boolean): string {
 return zh ? '使用 ${port} 为每个工作树分配空闲端口。' : 'Use ${port} for a free port per worktree.';
}
export function resolvedPortPreview(port: number, zh: boolean): string {
 return zh ? `此工作树的已分配端口：${port}` : `Resolved port for this worktree: ${port}`;
}
/** Keep a stale saved dependency visible long enough for its owner to remove it. */
export function dependencyOptionIds(catalog: readonly QuickLaunchCommand[], dependsOn: readonly string[], selfId?: string): string[] {
 const known = catalog.filter(command => command.id !== selfId).map(command => command.id);
 const knownIds = new Set(known);
 return [...known,...dependsOn.filter(id => id !== selfId && !knownIds.has(id))];
}
export function activeRun(sessions: readonly Session[], commandId: string, root: string): Session | undefined {
 return sessions.find(session => session.run?.commandId === commandId && !session.archived && !session.readOnly && ['starting','running','idle','waiting'].includes(session.status) && sameCanonicalScope(session.worktreePath, root));
}
export function runStateLabel(view: RunView, zh: boolean): string {
 const labels: Record<RunState, [string,string]> = { starting:['Starting','启动中'], ready:['Ready','已就绪'], running:['Running','运行中'], completed:['Completed','已完成'], exited:['Exited','已退出'], failed:['Failed','失败'], stopped:['Stopped','已停止'], interrupted:['Interrupted','已中断'] };
 if (view.state === 'failed') return view.exitCode === undefined ? (zh ? '启动失败' : 'Failed to start') : (zh ? `失败（退出码 ${view.exitCode}）` : `Failed (exit ${view.exitCode})`);
 return labels[view.state][zh ? 1 : 0];
}
export type PackageScript = { name: string; command: string; kind: QuickLaunchKind };
export function packageScripts(json: string, lockfiles: readonly string[]): PackageScript[] {
 let value: unknown;
 try { value = JSON.parse(json); } catch { throw new Error('package_scripts_invalid'); }
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('package_scripts_invalid');
 const scripts = (value as { scripts?: unknown }).scripts;
 if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) throw new Error('no_package_scripts');
 const names = lockfiles.map(path => path.split(/[\\/]/).at(-1));
 const manager = names.includes('pnpm-lock.yaml') ? 'pnpm' : names.includes('yarn.lock') ? 'yarn' : names.some(name => name === 'bun.lock' || name === 'bun.lockb') ? 'bun run' : 'npm run';
 return Object.entries(scripts).filter(([,script]) => typeof script === 'string').map(([name]) => {
  // Names are shell arguments, not command text. Refuse expansion/metacharacters rather than executing them.
  if (!/^[\w:./@-]+$/.test(name)) throw new Error('package_scripts_invalid');
  return { name, command: `${manager} ${name}`, kind: /^(dev|start|serve|preview|watch.*)$/i.test(name) ? 'service' : 'task' };
 });
}
/** Detected entries grouped by source kind, then by the manifest's own group (package or target file). */
export type DetectedSection = { kind: DetectedRunSourceKind; groups: { name: string; entries: DetectedRunEntry[] }[] };
const detectedOrder: DetectedRunSourceKind[] = ['node','cargo','maven','gradle','python','make','just','compose','procfile'];
export function detectedSections(entries: readonly DetectedRunEntry[]): DetectedSection[] {
 const byKind = new Map<DetectedRunSourceKind, Map<string, DetectedRunEntry[]>>();
 for (const entry of entries) {
  const groups = byKind.get(entry.source.kind) ?? new Map<string, DetectedRunEntry[]>();
  byKind.set(entry.source.kind, groups);
  const name = entry.group || entry.source.label || entry.source.file;
  groups.set(name, [...(groups.get(name) ?? []), entry]);
 }
 return detectedOrder.filter(kind => byKind.has(kind)).map(kind => ({ kind, groups: [...byKind.get(kind)!].map(([name, entries]) => ({ name, entries })) }));
}
export function detectedSourceLabel(kind: DetectedRunSourceKind, zh: boolean): string {
 const labels: Record<DetectedRunSourceKind,[string,string]> = { node:['Node scripts','Node 脚本'], cargo:['Cargo','Cargo'], maven:['Maven','Maven'], gradle:['Gradle','Gradle'], python:['Python','Python'], make:['Makefile','Makefile'], just:['just recipes','just 配方'], compose:['Compose services','Compose 服务'], procfile:['Procfile','Procfile'] };
 return labels[kind][zh ? 1 : 0];
}
/** A suggested entry was inferred from source code, not declared in a manifest: the row asks for a look first. */
export function suggestedLabel(zh: boolean): string {
 return zh ? '建议' : 'Suggested';
}
export function suggestedTitle(zh: boolean): string {
 return zh ? '根据源代码推断；保存前请检查命令。' : 'Found in source code; check the command before saving.';
}
/** The tag a detected row shows, decided here so the popover and the Run view cannot disagree. */
export function suggestedTag(detected: Pick<DetectedRunEntry, 'suggested'> | undefined, zh: boolean): { label: string; title: string } | undefined {
 return detected?.suggested ? { label: suggestedLabel(zh), title: suggestedTitle(zh) } : undefined;
}
/** A disabled detected row explains exactly which executable is missing. */
export function missingToolLabel(tool: string, zh: boolean): string {
 return zh ? `PATH 中找不到 ${tool}` : `${tool} isn't on PATH`;
}
const errors: Record<string,[string,string]> = {
 revision_conflict:['This command changed elsewhere. Reload it before saving; your draft is kept.','此命令已在其他窗口修改。请重新加载后再保存；草稿已保留。'],
 command_not_found:['This saved command no longer exists.','此保存的命令已不存在。'], too_many_commands:['A project can save up to 100 commands.','每个项目最多保存 100 个命令。'],
 cmd_single_line:['CMD runs one line — join commands with &&.','CMD 仅执行一行，请用 && 连接命令。'], shell_unavailable:['This shell is not installed or available.','此 Shell 未安装或不可用。'],
 cwd_outside_root:['The working directory must stay inside this worktree.','工作目录必须位于此工作树内。'], cwd_missing:['The working directory does not exist.','工作目录不存在。'],
 package_scripts_invalid:['Invalid package.json or unsupported script name. Use letters, digits, _, -, :, /, ., or @ in script names.','package.json 无效或脚本名称不受支持。名称请使用字母、数字、_、-、:、/、. 或 @。'], no_package_scripts:['No scripts were found in package.json.','package.json 中没有脚本。'],
 no_package_json:['No package.json was found in this directory.','此目录中没有 package.json。'], invalid_env:['Check environment names and remove duplicate names.','请检查环境变量名称并移除重复名称。'],
 invalid_preview_url:['Enter an http:// or https:// preview address.','请输入 http:// 或 https:// 预览地址。'],
 invalid_name:['Use a name of up to 80 characters without control characters.','名称最多 80 个字符，不能包含控制字符。'], invalid_command:['Enter command text of up to 8,000 characters.','请输入最多 8,000 个字符的命令。'], invalid_cwd:['Use a relative directory inside this worktree (up to 260 characters).','请使用此工作树内的相对目录（最多 260 个字符）。'],
 project_not_found:['This project no longer exists.','此项目已不存在。'], worktree_missing:['This worktree directory is missing.','此工作树目录已丢失。'], workspace_read_only:['This workspace is read-only.','此工作区为只读。'], workspace_archived:['Restore this archived workspace before running a command.','请恢复此已归档的工作区后再运行命令。'],
 setup_empty:['Choose at least one Task command in Worktree setup before running it.','请先在工作树初始化中选择至少一个任务命令。'], invalid_step:['This setup step is no longer available. Reopen the Run menu and try again.','此初始化步骤已不可用。请重新打开运行菜单后重试。'], not_a_task:['Only Task commands can be setup steps.','只有任务命令可以作为初始化步骤。'],
 detected_entry_not_found:['This detected entry no longer exists. Reopen Run to see the current list.','这条检测条目已不存在。重新打开 Run 查看当前列表。'], tool_not_found:['A tool this entry needs is not on PATH.','PATH 中找不到此条目所需的工具。'],
 nested_depends_on:['A dependency cannot have dependencies of its own.','依赖命令不能再包含依赖。'], invalid_depends_on:['Choose saved commands from this project without cycles or self-references.','请选择本项目中没有循环或自引用的保存命令。'],
 dependency_failed:['A required dependency failed to start.','所需依赖启动失败。'], port_unavailable:['A free port could not be allocated for this command.','无法为此命令分配可用端口。'],
 command_has_dependents:['This command is required by other saved commands. Remove it from their Start after lists first.','其他已保存命令依赖此命令。请先从它们的启动依赖列表中移除。'],
 repo_config_conflict:['The shared run file changed elsewhere. Reopen Run and review it before saving.','共享运行文件已在其他位置更改。请重新打开 Run，检查后再保存。'], repo_config_invalid:['.threadterm/run.json is invalid. Fix the file and reopen Run.','.threadterm/run.json 无效。请修复该文件后重新打开 Run。'],
 secret_missing:['Enter the missing secret value in the shared command editor.','请在共享命令编辑器中填写缺失的密钥值。'], repo_entry_not_found:['This shared entry no longer exists. Reopen Run to see the current file.','此共享条目已不存在。请重新打开 Run 查看当前文件。'],
};
export function quickLaunchError(error: unknown, zh: boolean): string {
 const message = error instanceof Error ? error.message : String(error);
 const aliases: Record<string,string> = { 'Invalid command name':'invalid_name', 'Invalid command text':'invalid_command', 'Invalid working directory':'invalid_cwd', 'Invalid environment overrides':'invalid_env', 'Invalid preview address':'invalid_preview_url' };
 const raw = Object.keys(aliases).find(key=>message.includes(key));
 const code = raw ? aliases[raw] : Object.keys(errors).find(key => message.includes(key));
 if (code === 'dependency_failed') { const name=message.match(/dependency_failed:\s*(.+)/)?.[1]; if(name)return zh?`依赖失败：${name}`:`Dependency failed: ${name}`; }
 if (code === 'command_has_dependents') { const names=message.match(/command_has_dependents:\s*(.+)/)?.[1]; if(names)return zh?`无法删除此命令，因为以下命令依赖它：${names}`:`Cannot delete this command because it is required by: ${names}`; }
 return code ? errors[code][zh ? 1 : 0] : workbenchError(error, zh);
}
