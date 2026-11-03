import type { ChatQueue, ChatQueueItem } from '@threadterm/protocol';
import { parseContext } from './chatContext';

type QueueWithAvailability = Pick<ChatQueue, 'paused' | 'pauseReason' | 'blocked'>;

export function queueActionAvailability(queue: QueueWithAvailability | undefined, zh = false): { available: boolean; reason?: string } {
  const reasons = zh
    ? { plan: '等待你审阅计划', approval: '等待你批准', working: '代理仍在运行', unavailable: '暂时无法发送' }
    : { plan: 'Waiting for your plan review', approval: 'Waiting for your approval', working: 'Agent is still working', unavailable: 'Sending is unavailable' };
  return !queue ? { available: false } : queue.blocked ? { available: false, reason: reasons[queue.blocked] } : { available: true };
}

export function queueRequestIssue(error: unknown, zh = false): string {
  return /chat_busy/.test(String(error))
    ? (zh ? '代理仍在运行，请稍后重试。' : 'The agent is still working. Try again in a moment.')
    : String(error);
}

/** The composer queues while a turn is live, and keeps adding to a paused queue. */
export function queueComposerMode(liveTurn: boolean, queue: ChatQueue | undefined): boolean {
  return liveTurn || Boolean(queue?.paused && queue.items.length);
}

export function queueItemSummary(item: Pick<ChatQueueItem, 'text' | 'images'>, zh = false): string {
  const parsed = parseContext(item.text);
  const line = (parsed?.text ?? item.text).split(/\r?\n/, 1)[0]?.trim() || (parsed ? (zh ? '仅上下文' : 'Context only') : (zh ? '仅图片' : 'Images only'));
  return item.images.length ? `${line} · ${zh ? `${item.images.length} 张图片` : `${item.images.length} image${item.images.length === 1 ? '' : 's'}`}` : line;
}

export function queuePauseReason(reason: ChatQueue['pauseReason'], zh = false): string {
  const labels = zh
    ? { user: '已手动暂停', stopped: '停止后已暂停', failed: '发送失败，已暂停', restarted: '运行时重启后已暂停', disconnected: '连接断开后已暂停' }
    : { user: 'Paused manually', stopped: 'Paused after stopping', failed: 'Paused after a send failed', restarted: 'Paused after runtime restart', disconnected: 'Paused after disconnecting' };
  return reason ? labels[reason] : (zh ? '已暂停' : 'Paused');
}
