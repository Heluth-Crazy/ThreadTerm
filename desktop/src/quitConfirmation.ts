import type { MessageBoxOptions, NativeImage } from 'electron';

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
