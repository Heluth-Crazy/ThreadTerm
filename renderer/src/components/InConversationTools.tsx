import { useRef, useState } from 'react';
import type { Settings } from '@threadterm/protocol';
import './in-conversation-tools.css';
export function InConversationTools({ settings, zh, update }: { settings: Settings; zh: boolean; update: (patch: Record<string, unknown>) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState(''), locked = useRef(false);
  const tools = settings.chatTools && typeof settings.chatTools === 'object' ? settings.chatTools as { generatedUi?: unknown } : undefined;
  const enabled = tools?.generatedUi === true, copy = (en: string, zhText: string) => zh ? zhText : en;
  return <section className="settings-in-conversation-tools"><h3>{copy('In-conversation tools', '对话内工具')}</h3>
    <div className="settings-generated-ui-row"><span>{copy('Generated UI', '生成式界面')}</span><button type="button" role="switch" className="btn btn-sm" data-testid="generated-ui-switch" aria-label={copy('Generated UI agent instructions', '生成式界面代理指令')} aria-checked={enabled} aria-pressed={enabled} disabled={busy} onClick={async () => {
      if (locked.current) return; locked.current = true; setBusy(true); setIssue('');
      try { await update({ chatTools: { generatedUi: !enabled } }); } catch (error) { setIssue(String(error)); } finally { locked.current = false; setBusy(false); }
    }}>{enabled ? copy('On', '开') : copy('Off', '关')}</button></div>
    <p className="note">{copy('Teach supported agents to produce cards and charts in future chats. Existing blocks always render.', '在后续对话中引导支持的代理生成卡片和图表。已有内容始终可以显示。')}</p>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </section>;
}
