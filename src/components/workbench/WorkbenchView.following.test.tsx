import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeCard, renderWorkbench } from './WorkbenchView.testHarness';

describe('WorkbenchView followed terminals', () => {
  it('follows from an attention row without opening or changing the terminal', () => {    const { callbacks } = renderWorkbench();

    fireEvent.click(screen.getAllByRole('button', { name: 'Add to Workbench' })[0]);

    expect(callbacks.onFollowCards).toHaveBeenCalledWith(['card-1']);
    expect(callbacks.onOpenTerminal).not.toHaveBeenCalled();
    expect(callbacks.onUnfollowCard).not.toHaveBeenCalled();
  });

  it('removes a followed terminal without opening or closing the terminal', () => {
    const followedCard = makeCard();
    const { callbacks } = renderWorkbench({
      followedCards: [followedCard],
      followedCardIds: [followedCard.id],
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Repo from Workbench' }),
    );

    expect(callbacks.onUnfollowCard).toHaveBeenCalledWith('card-1');
    expect(callbacks.onOpenTerminal).not.toHaveBeenCalled();
  });
});
