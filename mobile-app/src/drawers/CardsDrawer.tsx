import { X } from 'lucide-react';
import type { CardMeta } from '@shared/mobile/bridge/protocol';

interface CardsDrawerProps {
  open: boolean;
  cards: CardMeta[];
  activeCardId: string | null;
  onClose: () => void;
  onSelect: (cardId: string) => void;
}

export function CardsDrawer({ open, cards, activeCardId, onClose, onSelect }: CardsDrawerProps) {
  return (
    <aside className={`drawer drawer-left ${open ? 'drawer-open' : ''}`} aria-hidden={!open}>
      <div className="drawer-header">
        <div>
          <p className="drawer-kicker">Sessions</p>
          <h2>ThreadTerm</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close sessions">
          <X size={18} />
        </button>
      </div>
      <div className="drawer-list">
        {cards.length === 0 && <p className="empty-copy">No live terminal sessions yet.</p>}
        {cards.map((card) => (
          <button
            className={`session-row ${card.id === activeCardId ? 'session-row-active' : ''}`}
            type="button"
            key={card.id}
            onClick={() => {
              onSelect(card.id);
              onClose();
            }}
          >
            <span className={`status-dot status-${card.status}`} />
            <span className="session-row-main">
              <strong>{card.projectName || card.id}</strong>
              <span>{card.summaryLine || card.lastReplyPreview || card.projectPath}</span>
            </span>
            <span className="session-bytes">{formatBytes(card.recentOutputBytes)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${Math.round(value / 102.4) / 10} KB`;
}
