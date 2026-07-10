import { describe, expect, it } from 'vitest';
import { getCardFooterDensity } from './CardFooter';

describe('getCardFooterDensity', () => {
  it('keeps the default layout while width is not measurable', () => {
    expect(getCardFooterDensity(0)).toBe('wide');
  });

  it('keeps the full action row on wide cards', () => {
    expect(getCardFooterDensity(360)).toBe('wide');
    expect(getCardFooterDensity(420)).toBe('wide');
  });

  it('collapses optional actions on compact cards', () => {
    expect(getCardFooterDensity(300)).toBe('compact');
    expect(getCardFooterDensity(359)).toBe('compact');
  });

  it('keeps only core actions visible on narrow cards', () => {
    expect(getCardFooterDensity(299)).toBe('narrow');
    expect(getCardFooterDensity(240)).toBe('narrow');
  });
});

// ── Recent-notification mark (rendered component) ───────────────────────────
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CardFooter } from './CardFooter';
import { useTerminalStore } from '../../stores/terminalStore';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock('./AiIntentSelect', () => ({ AiIntentSelect: () => null }));
vi.mock('./CardActions', () => ({ CardActions: () => null }));
vi.mock('./AutoRestartStatus', () => ({ AutoRestartStatus: () => null }));

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    notifications: [],
    pendingFocusCardId: null,
    pendingLocateCardId: null,
    highlightCardId: null,
  });
}

function renderFooter(cardId: string) {
  const card = useTerminalStore.getState().getCardById(cardId)!;
  return render(
    <CardFooter
      card={card}
      aiSessionBadge={null}
      attentionHint={null}
      pinned={false}
      pinFull={false}
      onTogglePin={() => {}}
      autoRestartEnabled={false}
      autoRestartMaxRetries={3}
      onToggleAutoRestart={() => {}}
      onChangeAutoRestartMaxRetries={() => {}}
    />,
  );
}

describe('CardFooter recent-notification mark', () => {
  beforeEach(resetStore);
  afterEach(cleanup);

  it('shows the latest notification kind icon with a tooltip', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 'needs input', body: '' });

    const { container } = renderFooter(id);

    expect(container.querySelector('.lucide-clock')).not.toBeNull();
    expect(container.querySelector('[title*="needs input"]')).not.toBeNull();
  });

  it('uses the newest entry when several notifications exist', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 'older', body: '' });
    s.pushNotification({ cardId: id, kind: 'completed', title: 'newest', body: '' });

    const { container } = renderFooter(id);

    expect(container.querySelector('.lucide-circle-check-big, .lucide-check-circle-2, .lucide-circle-check')).not.toBeNull();
    expect(container.querySelector('[title*="newest"]')).not.toBeNull();
  });

  it('renders no mark when the card has no notifications', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });

    const { container } = renderFooter(id);

    expect(container.querySelector('.lucide-clock')).toBeNull();
    expect(container.querySelector('.lucide-bell-ring')).toBeNull();
  });
});
