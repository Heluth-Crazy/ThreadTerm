export function contextError(error: unknown, zh: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  const bilingual = message.split(' / ');
  if (bilingual.length > 1) return zh ? bilingual.slice(1).join(' / ') : bilingual[0];
  if (!zh || /[\u3400-\u9fff]/.test(message)) return message;
  if (/128|bytes|size|KiB/i.test(message)) return '消息与上下文总量不能超过 128 KiB。请缩短消息或移除上下文。';
  if (/\b12\b|items|count/i.test(message)) return '最多可附加 12 项上下文。请先移除一项。';
  if (/unavailable/i.test(message)) return '该聊天当前不能接收上下文，请等待连接完成并取得控制权。';
  if (/quota|storage/i.test(message)) return '本地存储不可用，无法保存上下文草稿。';
  return '无法附加上下文。请检查内容，或移除无效的上下文草稿。';
}
