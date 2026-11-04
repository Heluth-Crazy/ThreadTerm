import type { MessageBoxOptions, NativeImage } from 'electron';
import type { PairedDevice } from '@threadterm/protocol';

/**
 * Test-only: real-app QA launches set this so app.close() takes the normal confirmed-quit path instead of
 * blocking on a native dialog that automation cannot answer. Production launchers never set it.
 */
export function quitConfirmationPreapproved(env: Record<string, string | undefined>): boolean {
  return env.THREADTERM_V3_QA_AUTO_CONFIRM_QUIT === '1';
}

/** Copy and standard Windows buttons; lifecycle decisions remain in main. */
export function quitConfirmationOptions(zh: boolean, icon: NativeImage): MessageBoxOptions {
  return {
    type: 'warning', noLink: true, icon,
    buttons: zh ? ['继续运行', '退出应用'] : ['Keep running', 'Exit application'],
    defaultId: 0, cancelId: 0,
    title: zh ? '退出 ThreadTerm？' : 'Exit ThreadTerm?',
    message: zh ? '退出会停止正在运行的会话。' : 'Exiting will stop running sessions.',
    detail: zh ? '继续运行可保留后台任务。' : 'Keep running to leave background work active.',
  };
}

export type HostingQuitChoice = 'keep' | 'stop' | 'cancel';
export interface HostingQuitContext { connectedNames: string[] }

/** Unknown device data on a running host is conservative; stale lastSeenAt is never live presence. */
export function hostingQuitContext(runtimeRunning: boolean, enabled: boolean, devices?: PairedDevice[]): HostingQuitContext | undefined {
  if (!runtimeRunning || !enabled) return undefined;
  if (!devices) return { connectedNames: [] };
  const desktops = devices.filter(device => device.profile === 'desktop' && !device.revokedAt);
  return desktops.length ? { connectedNames: desktops.filter(device => device.connected).map(device => device.name) } : undefined;
}

export function hostingQuitChoice(response: number): HostingQuitChoice {
  return response === 0 ? 'keep' : response === 1 ? 'stop' : 'cancel';
}

/** This QA override is deliberately unavailable in packaged applications. */
export function hostingQuitQaChoice(isPackaged: boolean, env: Record<string, string | undefined>): HostingQuitChoice | undefined {
  if (isPackaged) return undefined;
  const value = env.THREADTERM_V3_QA_HOST_QUIT_CHOICE;
  return value === 'keep' || value === 'stop' ? value : undefined;
}

export function hostingQuitOptions(zh: boolean, icon: NativeImage, context: HostingQuitContext): MessageBoxOptions {
  const names = context.connectedNames.join(zh ? '、' : ', ');
  const who = names || (zh ? '其他电脑' : 'other computers');
  const several = context.connectedNames.length !== 1;
  return {
    type: 'warning', noLink: true, icon,
    title: zh ? '退出 ThreadTerm？' : 'Exit ThreadTerm?',
    message: names ? (zh ? `${names} 正在使用本机` : `${names} ${several ? 'are' : 'is'} using this PC`) : (zh ? '其他电脑可以使用本机' : 'Other computers can use this PC'),
    detail: zh ? `退出时可以让会话继续运行，${who}就能继续工作。之后可以在这里或在 ${who} 上停止它们。` : `Quitting can leave your sessions running so ${who} ${several ? 'keep' : 'keeps'} working. You can stop them later from here or from ${who}.`,
    buttons: zh ? ['退出，保持运行', '全部停止', '取消'] : ['Quit, keep running', 'Stop everything', 'Cancel'],
    defaultId: 0, cancelId: 2,
  };
}
