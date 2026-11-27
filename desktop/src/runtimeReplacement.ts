// What a desktop asks when the runtime it finds running is not the one it brought (11-26). The runtime is a detached
// daemon shared by every desktop of one user; it outlives its desktop while sessions run or other computers are
// served, so a newer portable package can start beside a daemon an older package left. Before, the two agreed at the
// handshake and then rejected each other's replies without a word.
//
// Two cases: a legacy daemon (contract 20) this desktop cannot work with at all — restart it or quit; a daemon of the
// same contract but another build — restart it or keep it this time. Never restarted without asking: a digest says
// that two builds differ, not which one is newer, and a restart ends the sessions it runs.

export type RuntimeReplacementChoice = 'restart' | 'keep' | 'quit';
/** `liveSessions` undefined: the runtime's session list could not be read. */
export interface RuntimeReplacementFacts { legacy: boolean; liveSessions?: number; remoteAccess: boolean; runtimePath?: string; zh: boolean }
export interface RuntimeReplacementPrompt { title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }

export function runtimeReplacementPrompt({ legacy, liveSessions, remoteAccess, runtimePath, zh }: RuntimeReplacementFacts): RuntimeReplacementPrompt {
  const lines: string[] = [];
  if (!legacy && runtimePath) lines.push(zh ? `它的位置：${runtimePath}` : `It runs from ${runtimePath}`);
  if (liveSessions === undefined) lines.push(zh ? '读不到它正在运行哪些会话；重启后台程序会结束正在运行的会话，之后可以继续它们。' : 'Its sessions could not be read; restarting it ends any that run, and you can continue them afterwards.');
  // A restart ends whatever runs at that moment, also a session another window starts after this was read.
  else if (liveSessions > 0) lines.push(zh ? `重启会结束它正在运行的所有会话（现在 ${liveSessions} 个），之后可以继续它们。` : `Restarting it ends every session it runs (${liveSessions} now); you can continue them afterwards.`);
  else lines.push(zh ? '现在没有正在运行的会话；重启时正在运行的会话都会结束，之后可以继续。' : 'No session is running now; any running at the restart ends, and you can continue it afterwards.');
  if (remoteAccess) lines.push(zh ? '配对的电脑会暂时断开。' : 'Paired computers are disconnected for a moment.');
  lines.push(zh ? '如果另一个版本的 ThreadTerm 窗口还开着，请先关闭它。' : 'If a window of the other ThreadTerm is still open, close it first.');
  return {
    title: 'ThreadTerm',
    message: legacy
      ? (zh ? '正在运行的后台程序来自旧版 ThreadTerm，这个版本不能使用它。' : 'The background program that is running comes from an older ThreadTerm, and this version cannot use it.')
      : (zh ? '正在运行的后台程序来自另一个版本的 ThreadTerm。' : 'The background program that is running comes from another version of ThreadTerm.'),
    detail: lines.join('\n'),
    buttons: legacy
      ? (zh ? ['重启后台程序', '退出'] : ['Restart background program', 'Quit'])
      : (zh ? ['重启后台程序', '这次不重启'] : ['Restart background program', 'Not this time']),
    defaultId: 0,
    cancelId: 1,
  };
}

export function runtimeReplacementChoice(response: number, legacy: boolean): RuntimeReplacementChoice {
  if (response === 0) return 'restart';
  return legacy ? 'quit' : 'keep';
}

/** QA answer for the dialog: unpackaged runs only, THREADTERM_QA_RUNTIME_REPLACE=restart|keep|quit. */
export function runtimeReplacementQaChoice(packaged: boolean, environment: Record<string, string | undefined>): RuntimeReplacementChoice | undefined {
  if (packaged) return undefined;
  const value = environment.THREADTERM_QA_RUNTIME_REPLACE;
  return value === 'restart' || value === 'keep' || value === 'quit' ? value : undefined;
}

/** Whether a restart still ends no more than the dialog said, read again just before it: more sessions running,
 * paired computers newly served, or a list that can no longer be read mean the user is asked again. */
export function restartStillAsTold(told: { liveSessions?: number; remoteAccess: boolean }, now: { liveSessions?: number; remoteAccess: boolean }): boolean {
  if (now.remoteAccess && !told.remoteAccess) return false;
  if (told.liveSessions === undefined) return true;
  return now.liveSessions !== undefined && now.liveSessions <= told.liveSessions;
}

/** After a restart, what the ordinary connection reached. `legacy`: an older desktop that is still open started its
 * own runtime again, which this desktop cannot use. `other-build`: a compatible runtime of another build (known
 * digests that differ) started first; this desktop works with it, the user is told. */
export function replacementOutcome(found: { contract: number; build?: { sha256: string } } | undefined, currentContract: number, ownDigest: string | undefined): 'ok' | 'legacy' | 'other-build' {
  if (!found) return 'ok';
  if (found.contract !== currentContract) return 'legacy';
  return ownDigest && found.build && found.build.sha256 !== ownDigest ? 'other-build' : 'ok';
}

/** The runtime kept changing while the user was asked (connections dropped, a restart came to end more): no restart
 * without a decision on what is true now. Legacy: only quitting is possible; another build: keep it or quit. */
export function runtimeUnsettledPrompt(legacy: boolean, zh: boolean): RuntimeReplacementPrompt {
  return {
    title: 'ThreadTerm',
    message: zh ? '后台程序在询问期间一直在变化，没有重启它。' : 'The background program kept changing while you were asked, so it was not restarted.',
    detail: legacy
      ? (zh ? '这个版本不能使用正在运行的旧版后台程序。请关闭其他 ThreadTerm 窗口，然后重新打开这个版本。' : 'This version cannot use the older background program. Close other ThreadTerm windows, then open this one again.')
      : (zh ? '可以先继续使用正在运行的后台程序；要换成这个版本的，请关闭其他 ThreadTerm 窗口后重新打开。' : 'You can keep working with the running background program; to use this version\'s, close other ThreadTerm windows and open this one again.'),
    buttons: legacy ? (zh ? ['退出'] : ['Quit']) : (zh ? ['继续使用', '退出'] : ['Keep working', 'Quit']),
    defaultId: 0,
    cancelId: 0,
  };
}

export function replacementOutcomePrompt(outcome: 'legacy' | 'other-build', zh: boolean): RuntimeReplacementPrompt {
  return outcome === 'legacy'
    ? {
      title: 'ThreadTerm',
      message: zh ? '旧版 ThreadTerm 又启动了它自己的后台程序。' : 'The older ThreadTerm started its own background program again.',
      detail: zh ? '请关闭旧版 ThreadTerm，然后重新打开这个版本。' : 'Close the older ThreadTerm, then open this one again.',
      buttons: zh ? ['退出'] : ['Quit'],
      defaultId: 0,
      cancelId: 0,
    }
    : {
      title: 'ThreadTerm',
      message: zh ? '另一个版本的 ThreadTerm 先启动了它自己的后台程序。' : 'Another version of ThreadTerm started its own background program first.',
      detail: zh ? '这个版本可以继续使用它，但两边的修复和改动不一定一致。要用这个版本的后台程序，请关闭另一个版本后重新打开。' : 'This version can keep working with it, but fixes and changes may differ. To use this version\'s background program, close the other version and open this one again.',
      buttons: zh ? ['继续使用', '退出'] : ['Keep working', 'Quit'],
      defaultId: 0,
      cancelId: 0,
    };
}
