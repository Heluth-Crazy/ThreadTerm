import { providerRetryPresentation } from '../providerRetry';

export function ProviderRetryStatus({ data, copy }: { data: unknown; copy: (en: string, zh: string) => string }) {
  const retry = providerRetryPresentation(data);
  if (!retry) return null;
  const count = retry.kind === 'legacy-grok' && retry.attempt !== undefined && retry.maxRetries !== undefined ? ` (${retry.attempt}/${retry.maxRetries})` : '';
  const nativeCount = retry.kind === 'native' && retry.attempt !== undefined ? ` (${copy('Attempt', '尝试')} ${retry.attempt})` : '';
  return <div className="chat-network-notice" role="status" aria-live="polite">
    {retry.kind === 'legacy-grok' ? <><strong>{retry.state === 'retrying' ? copy('Connection interrupted · retrying', '连接遇到问题，正在重试') + count : retry.state === 'failed' ? copy('Could not reach Grok', '未能连接 Grok') : retry.state === 'stopped' ? copy('Connection retry stopped', '已停止连接重试') : copy('Connection retry finished', '连接重试已结束')}</strong>
      <p>{retry.state === 'retrying' ? copy('Grok is retrying the request. You can stop this turn using the Stop button below.', 'Grok 正在重新尝试请求，可使用下方停止按钮结束本轮。') : retry.state === 'failed' ? copy('Check your network and the Grok proxy in Settings → Tools, then start a new session to apply proxy changes.', '请检查网络及“设置 → 工具”中的 Grok 代理；修改代理后，新建会话使其生效。') : copy('Your conversation has been kept.', '会话内容已保留。')}</p></>
      : <><strong>{retry.state === 'retrying' ? copy('Request retrying', '请求正在重试') + nativeCount : retry.state === 'failed' ? copy('Request retry failed', '请求重试失败') : retry.state === 'stopped' ? copy('Request retry stopped', '请求重试已停止') : copy('Request retry finished', '请求重试已完成')}</strong>
        {retry.message && <p>{retry.message}</p>}{retry.next && <p>{copy('Next retry', '下次重试')}: {retry.next}</p>}</>}
  </div>;
}
