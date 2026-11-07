export function timeLabel(value: string | number | undefined, locale: 'en' | 'zh-CN') {
  if (!value) return locale === 'zh-CN' ? '未知时间' : 'Unknown time';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const delta = Math.max(0, Date.now() - date.valueOf());
  const unit: readonly [string, number] = delta < 60_000 ? ['s', 1_000] : delta < 3_600_000 ? ['m', 60_000] : delta < 86_400_000 ? ['h', 3_600_000] : ['d', 86_400_000];
  const amount = Math.max(1, Math.floor(delta / unit[1]));
  return locale === 'zh-CN' ? `${amount}${unit[0] === 's' ? '秒' : unit[0] === 'm' ? '分钟' : unit[0] === 'h' ? '小时' : '天'}前` : `${amount}${unit[0]} ago`;
}

export function machineSummary(state: string, locale: 'en' | 'zh-CN') {
  const text: Record<string, [string, string]> = {
    connected: ['Connected', '已连接'], connecting: ['Connecting', '正在连接'], disconnected: ['Offline', '离线'], incompatible: ['Version mismatch', '版本不匹配'], 'pin-mismatch': ['Identity changed', '身份已变更'], revoked: ['Access revoked', '访问已撤销'],
  };
  return (text[state] ?? ['Unknown', '未知'])[locale === 'zh-CN' ? 1 : 0];
}

export function permissionLabel(value: 'readonly' | 'fullcontrol', locale: 'en' | 'zh-CN') { return value === 'fullcontrol' ? (locale === 'zh-CN' ? '可控制' : 'Control') : (locale === 'zh-CN' ? '仅查看' : 'View only'); }
export function sessionStatusLabel(value: string, locale: 'en' | 'zh-CN') {
  const text: Record<string, [string, string]> = { starting: ['Starting', '正在启动'], running: ['Running', '运行中'], idle: ['Ready', '就绪'], waiting: ['Needs you', '等待处理'], exited: ['Ended', '已结束'], interrupted: ['Interrupted', '已中断'], error: ['Failed', '失败'] };
  return (text[value] ?? [value, value])[locale === 'zh-CN' ? 1 : 0];
}

export function shortPath(path: string | undefined) {
  if (!path) return '';
  return path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join(' / ');
}
