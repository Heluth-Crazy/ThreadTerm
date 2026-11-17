import { useState } from 'react';
import { automaticSummary, automaticUpdateLabel, type Copy } from '../automaticUpdate';
import { agentIconMarkup, AgentTile, Icon } from './PrototypeIcon';
import './chat-automatic.css';

/**
 * R14: an automatic delegate update is ThreadTerm talking to the parent agent, not the
 * user's words. It reads as one dense system row — ⚡ 自动唤醒 plus the first update —
 * and opens to every update line in the user's language.
 */
export function ChatAutomaticRow({ text, copy }: { text: string; copy: Copy }) {
  const [open, setOpen] = useState(false);
  const { first, more, updates } = automaticSummary(text, copy);
  return <div className="chat-auto" data-testid="chat-automatic-row">
    <button type="button" className="chat-auto-row" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="chat-auto-tag"><Icon name="bolt" />{copy('Automatic update', '自动唤醒')}</span>
      <span className="chat-auto-text">{first}</span>
      {more > 0 && <span className="chat-auto-more">{copy(`${more} more`, `等 ${more} 条`)}</span>}
      <Icon name="chevD" className="chat-auto-chev" />
    </button>
    {open && <div className="chat-auto-lines">
      {updates.map((update, index) => <p className="chat-auto-line" key={index}>
        {update.kind !== 'text' && update.agent && agentIconMarkup(update.agent) !== undefined && <AgentTile provider={update.agent} size={13} />}
        <span>{automaticUpdateLabel(update, copy)}</span>
      </p>)}
    </div>}
  </div>;
}
