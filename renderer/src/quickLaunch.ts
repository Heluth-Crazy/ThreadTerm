import type { QuickLaunchKind, Session } from '@threadterm/protocol';
import { sameCanonicalScope } from './projectScope';
import { workbenchError } from './workbench/errors';

export type RunState = 'starting'|'running'|'completed'|'exited'|'failed'|'stopped'|'interrupted';
export type RunView = { state: RunState; exitCode?: number; url?: string };
export function runState(session: Pick<Session, 'status'|'exitCode'|'run'>): RunView {
 const { status, exitCode, run } = session;
 const state: RunState = status === 'starting' ? 'starting' : ['running','idle','waiting'].includes(status) ? 'running' : run?.stopRequested ? 'stopped' : status === 'interrupted' ? 'interrupted' : status === 'error' || (exitCode !== undefined && exitCode !== 0) ? 'failed' : exitCode === 0 && run?.kind === 'task' ? 'completed' : 'exited';
 return { state, exitCode, url: run?.url };
}
export function activeRun(sessions: readonly Session[], commandId: string, root: string): Session | undefined {
 return sessions.find(session => session.run?.commandId === commandId && !session.archived && !session.readOnly && ['starting','running','idle','waiting'].includes(session.status) && sameCanonicalScope(session.worktreePath, root));
}
export function runStateLabel(view: RunView, zh: boolean): string {
 const labels: Record<RunState, [string,string]> = { starting:['Starting','启动中'], running:['Running','运行中'], completed:['Completed','已完成'], exited:['Exited','已退出'], failed:['Failed','失败'], stopped:['Stopped','已停止'], interrupted:['Interrupted','已中断'] };
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
};
export function quickLaunchError(error: unknown, zh: boolean): string {
 const message = error instanceof Error ? error.message : String(error);
 const aliases: Record<string,string> = { 'Invalid command name':'invalid_name', 'Invalid command text':'invalid_command', 'Invalid working directory':'invalid_cwd', 'Invalid environment overrides':'invalid_env', 'Invalid preview address':'invalid_preview_url' };
 const raw = Object.keys(aliases).find(key=>message.includes(key));
 const code = raw ? aliases[raw] : Object.keys(errors).find(key => message.includes(key));
 return code ? errors[code][zh ? 1 : 0] : workbenchError(error, zh);
}
