import { runtimeErrorText } from './runtimeErrors';

/**
 * Request failures, classified once in `bridge.request` (owner 11-25: "Error invoking remote method
 * 'threadterm:request': RuntimeUnavailableError: Runtime request worktree.list timed out" sat in a red bar inside the
 * workspace and stayed after the runtime answered again). A failure is either the runtime's own answer (a code and
 * a message the view explains) or a transport failure: the runtime did not answer in time, or the connection to it
 * dropped. Transport failures are not the view's business: they get one app-wide notice that goes away by itself
 * once the runtime answers again, and views reload what they could not read.
 */
export type TransportKind = 'timeout' | 'unavailable';

export class RuntimeRequestError extends Error {
  readonly code: string | undefined;
  readonly method: string;
  readonly transport: TransportKind | undefined;
  constructor(message: string, method: string, code: string | undefined, transport: TransportKind | undefined, cause: unknown) {
    super(message);
    this.name = 'Error';
    this.code = code;
    this.method = method;
    this.transport = transport;
    (this as { cause?: unknown }).cause = cause;
  }
}

/** Reads that change nothing: safe to send again, and a failed one only leaves a view out of date. */
const REPEATABLE_READS = new Set<string>([
  'runtime.snapshot', 'runtime.health', 'runtime.resourceSample', 'system.notificationState', 'terminal.host', 'terminal.read',
  'catalog.visibility.list', 'project.catalog.list', 'provider.list', 'plugin.list',
  'chat.snapshot', 'chat.draft.read', 'chat.read', 'chat.queue.read', 'chat.connection', 'chat.context.read', 'chat.options',
  'chat.subagent.read', 'chat.backgroundTasks.list', 'chat.feedback.read', 'chat.image.read',
  'chat.tool.run.list', 'chat.tool.run.status', 'chat.tool.run.logs',
  'worktree.list', 'worktree.branches', 'group.list', 'group.read', 'group.prerequisites',
  'git.status', 'git.diff', 'git.fingerprints', 'git.history.plan', 'git.log', 'git.push.preview', 'git.stash.list',
  'git.stash.show', 'git.undo.list', 'git.branches', 'git.commit.show', 'git.commit.diff', 'git.blame',
  'git.compare.files', 'git.compare.diff',
  'filesystem.list', 'filesystem.read', 'filesystem.readWindow', 'filesystem.document.read', 'filesystem.files',
  'filesystem.search', 'filesystem.image', 'filesystem.preview.read', 'filesystem.resolve', 'attachment.read',
  'filesystem.external.read', 'filesystem.external.readWindow', 'filesystem.external.image', 'filesystem.external.list',
  'filesystem.external.document.read',
  'review.list', 'review.changes', 'review.diff', 'reviewDrafts.list', 'agentReview.list', 'codeReview.options',
  'session.launch.read', 'session.documents.list', 'session.config.read', 'session.retry.read',
  'quickLaunch.list', 'quickLaunch.detect', 'quickLaunch.port.read', 'quickLaunch.repo.list', 'quickLaunch.recent',
  'quickLaunch.proposals.list', 'quickLaunch.setup.read', 'quickLaunch.setup.status',
  'usage.query', 'usage.ledger.summary', 'usage.ledger.series', 'usage.ledger.breakdown', 'usage.ledger.sessions',
  'usage.ledger.session', 'usage.ledger.sources', 'usage.ledger.settings',
  'history.list', 'history.read', 'draft.list', 'data.status', 'data.relocation.status', 'device.list', 'device.status',
  'browser.approval.read',
]);

export const isRepeatableRead = (method: string): boolean => REPEATABLE_READS.has(method);

const TRANSPORT = /RuntimeUnavailableError|Runtime pipe closed|Runtime control pipe is unavailable|Timed out connecting to the runtime|Could not connect to the runtime|Runtime connection changed before|did not respond for \d+ seconds/i;
const TIMEOUT = /Runtime request \S+ timed out/i;

/** Whether a failure is the runtime not answering (`timeout`) or the connection being gone (`unavailable`). */
export function transportKind(error: unknown): TransportKind | undefined {
  if (error instanceof RuntimeRequestError) return error.transport;
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (!TRANSPORT.test(raw)) return undefined;
  return TIMEOUT.test(raw) ? 'timeout' : 'unavailable';
}

export const isTransportFailure = (error: unknown): boolean => transportKind(error) !== undefined;

const readerZh = () => (globalThis.document?.documentElement?.lang ?? '').toLowerCase().startsWith('zh');

/** The app-wide notice for a transport failure. */
export function transportText(kind: TransportKind, zh: boolean): string {
  return kind === 'timeout'
    ? zh ? 'ThreadTerm 后台暂时没有响应，部分内容可能还没更新。它恢复后会自动刷新。' : 'ThreadTerm’s background service is slow to answer. Some views may be out of date; they refresh once it answers.'
    : zh ? '与 ThreadTerm 后台的连接中断了，正在重新连接…' : 'Lost the connection to ThreadTerm’s background service. Reconnecting…';
}

/** What an action learns when the runtime did not confirm it in time: it may still be running. */
function actionTimeoutText(zh: boolean): string {
  return zh ? '后台没有及时确认这个操作，它可能仍在进行。请稍后查看结果再重试。' : 'The background service did not confirm this in time; it may still be running. Check the result before trying again.';
}

/**
 * The error a view receives: transport failures in the reader's language with a `runtime_timeout` /
 * `runtime_unavailable` code, the runtime's own failures without Electron's IPC wrapper (their codes stay first, so
 * `runtimeErrorCode` still reads them).
 */
export function normalizeRequestError(caught: unknown, method: string, zh = readerZh()): Error {
  if (caught instanceof RuntimeRequestError) return caught;
  const kind = transportKind(caught);
  if (kind) {
    const text = kind === 'timeout' && !isRepeatableRead(method) ? actionTimeoutText(zh) : transportText(kind, zh);
    return new RuntimeRequestError(text, method, kind === 'timeout' ? 'runtime_timeout' : 'runtime_unavailable', kind, caught);
  }
  if (caught instanceof Error && /^Error invoking remote method/i.test(caught.message)) {
    return new RuntimeRequestError(runtimeErrorText(caught) ?? caught.message, method, undefined, undefined, caught);
  }
  return caught instanceof Error ? caught : new Error(String(caught));
}

/** Text for a view's own error line: undefined for transport failures, which the app-wide notice covers. */
export function inlineErrorText(error: unknown, explain: (error: unknown) => string): string | undefined {
  return isTransportFailure(error) ? undefined : explain(error);
}
