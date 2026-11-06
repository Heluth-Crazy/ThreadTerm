import { runtimeText } from './contextErrors';
import { runtimeErrorCode, runtimeErrorText } from './runtimeErrors';

/** Reader-language copy for a runtime code the UI can explain itself. The IPC
 * round trip drops typed fields, but the runtime repeats the code in the message
 * (`response_too_large: …`), so `runtimeErrorCode` still recovers it. */
const CODE_TEXT: Record<string, [string, string]> = {
  outbox_history_pruned: ['Older event history was removed. Refreshing the session snapshot.', '较早的事件记录已清理，正在刷新会话快照。'],
  response_too_large: ['This part of the conversation is too large to load at once.', '此部分对话过大，无法一次加载。'],
  schema_too_new: ['This database was upgraded by a newer ThreadTerm. Update the app or restore a backup.', '此数据库已由较新的 ThreadTerm 升级。请更新应用或恢复备份。'],
  iroh_unreachable: ['Couldn’t reach that computer across networks. Make sure ThreadTerm is open there and “Connect across networks” is on.', '无法跨网络连接到那台电脑。请确认那台电脑上的 ThreadTerm 已打开，并已开启“跨网络连接”。'],
  iroh_not_ready: ['Connecting across networks is still starting. Try again in a moment.', '跨网络连接正在启动，请稍后再试。'],
  iroh_unavailable: ['Connecting across networks could not start on this PC.', '本机无法启动跨网络连接。'],
  invalid_relay_url: ['Enter the relay address as https://…', '请以 https://… 的格式填写中继地址。'],
  tailscale_not_connected: ['Tailscale is not connected on this PC. Start Tailscale and sign in, or turn off “Only accept devices on my Tailscale network” to pair on the same local network.', '本机未连接 Tailscale。请启动并登录 Tailscale，或关闭“仅接受我的 Tailscale 网络中的设备”，在同一局域网内配对。'],
  schema_backup_failed: ['ThreadTerm could not back up the database before upgrading it. Check free disk space and folder permissions, then try again.', 'ThreadTerm 无法在升级数据库前创建备份。请检查磁盘空间和文件夹权限，然后重试。'],
};

/** What to show the user for a failed request: their own language, never the IPC wrapper. */
export function userErrorText(caught: unknown, fallback: string, zh: boolean): string {
  const typed = caught && typeof caught === 'object' ? (caught as { code?: unknown }).code : undefined;
  const code = typeof typed === 'string' && typed ? typed : runtimeErrorCode(caught);
  const known = code ? CODE_TEXT[code] : undefined;
  if (known) return known[zh ? 1 : 0];
  const message = runtimeText(runtimeErrorText(caught) ?? '', zh).trim();
  return message || fallback;
}

/** Settings → Computers: a pairing check names the address it could not reach (`computer_unreachable: host:port`). */
export function pairingErrorText(caught: unknown, zh: boolean): string {
  const unreachable = /^computer_unreachable: (\S+)/.exec(runtimeErrorText(caught) ?? '');
  if (unreachable) {
    return zh
      ? `无法连接到 ${unreachable[1]}。请确认那台电脑上的 ThreadTerm 已打开，并且两台电脑在同一网络或同一个 Tailscale 网络中。`
      : `Couldn’t reach ${unreachable[1]}. Make sure ThreadTerm is open on that computer and both computers are on the same network or the same Tailscale network.`;
  }
  return userErrorText(caught, zh ? '操作未完成。' : 'That didn’t work.', zh);
}
