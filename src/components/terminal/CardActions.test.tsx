import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

import { CardActions } from './CardActions';

afterEach(() => {
  cleanup();
});

function renderActions(overrides: Partial<Parameters<typeof CardActions>[0]> = {}) {
  const props = {
    pinned: false,
    pinFull: false,
    onCopyCwd: vi.fn(),
    onOpenDir: vi.fn(),
    onTogglePin: vi.fn(),
    ...overrides,
  };
  render(<CardActions {...props} />);
  return props;
}

describe('CardActions', () => {
  it('invokes onCopyCwd when the copy button is clicked', () => {
    const props = renderActions();
    fireEvent.click(screen.getByTitle('card.copyPath'));
    expect(props.onCopyCwd).toHaveBeenCalledTimes(1);
  });

  it('invokes onOpenDir when the reveal button is clicked', () => {
    const props = renderActions();
    fireEvent.click(screen.getByTitle('card.revealProject'));
    expect(props.onOpenDir).toHaveBeenCalledTimes(1);
  });

  it('invokes onTogglePin when an unpinned card is clicked', () => {
    const props = renderActions();
    fireEvent.click(screen.getByTitle('card.pin'));
    expect(props.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('shows the unpin label when the card is pinned', () => {
    const props = renderActions({ pinned: true });
    fireEvent.click(screen.getByTitle('card.unpin'));
    expect(props.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('disables the pin button when the pin slate is full and the card is not pinned', () => {
    const props = renderActions({ pinned: false, pinFull: true });
    const pinButton = screen.getByTitle('card.pinFull');
    expect(pinButton).toBeDisabled();
    fireEvent.click(pinButton);
    expect(props.onTogglePin).not.toHaveBeenCalled();
  });

  it('keeps the pin button enabled when the slate is full but this card is already pinned', () => {
    const props = renderActions({ pinned: true, pinFull: true });
    const pinButton = screen.getByTitle('card.unpin');
    expect(pinButton).not.toBeDisabled();
    fireEvent.click(pinButton);
    expect(props.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('stops click events from propagating to the card surface', () => {
    const onCopyCwd = vi.fn();
    const surfaceClick = vi.fn();
    render(
      <div onClick={surfaceClick}>
        <CardActions
          pinned={false}
          pinFull={false}
          onCopyCwd={onCopyCwd}
          onOpenDir={vi.fn()}
          onTogglePin={vi.fn()}
        />
      </div>,
    );
    fireEvent.click(screen.getByTitle('card.copyPath'));
    expect(onCopyCwd).toHaveBeenCalledTimes(1);
    expect(surfaceClick).not.toHaveBeenCalled();
  });

  it('invokes AI session export without propagating to the card surface', () => {
    const onExportAiSession = vi.fn();
    const surfaceClick = vi.fn();
    render(
      <div onClick={surfaceClick}>
        <CardActions
          pinned={false}
          pinFull={false}
          onCopyCwd={vi.fn()}
          onOpenDir={vi.fn()}
          onTogglePin={vi.fn()}
          onExportAiSession={onExportAiSession}
        />
      </div>,
    );
    fireEvent.click(screen.getByLabelText('aiExport.exportMarkdown'));
    expect(onExportAiSession).toHaveBeenCalledTimes(1);
    expect(surfaceClick).not.toHaveBeenCalled();
  });

  it('invokes archive without propagating to the card surface', () => {
    const onArchive = vi.fn();
    const surfaceClick = vi.fn();
    render(
      <div onClick={surfaceClick}>
        <CardActions
          pinned={false}
          pinFull={false}
          onCopyCwd={vi.fn()}
          onOpenDir={vi.fn()}
          onTogglePin={vi.fn()}
          onArchive={onArchive}
        />
      </div>,
    );
    fireEvent.click(screen.getByTitle('card.archive'));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(surfaceClick).not.toHaveBeenCalled();
  });
});
