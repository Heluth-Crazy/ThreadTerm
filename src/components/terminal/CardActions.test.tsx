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

  it('moves optional actions into the overflow menu in compact density', () => {
    const onArchive = vi.fn();
    const onExportAiSession = vi.fn();
    const onTogglePin = vi.fn();
    const surfaceClick = vi.fn();
    render(
      <div onClick={surfaceClick}>
        <CardActions
          pinned={false}
          pinFull={false}
          onCopyCwd={vi.fn()}
          onOpenDir={vi.fn()}
          onTogglePin={onTogglePin}
          onArchive={onArchive}
          onExportAiSession={onExportAiSession}
          density="compact"
        />
      </div>,
    );

    expect(screen.getByTitle('card.copyPath')).toBeInTheDocument();
    expect(screen.getByTitle('card.revealProject')).toBeInTheDocument();
    expect(screen.queryByTitle('card.pin')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('view.more'));
    fireEvent.click(screen.getByTitle('card.pin'));
    expect(onTogglePin).toHaveBeenCalledTimes(1);

    // The menu closes after each one-shot action; reopen for the next item.
    fireEvent.click(screen.getByTitle('view.more'));
    fireEvent.click(screen.getByTitle('card.archive'));
    expect(onArchive).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('view.more'));
    fireEvent.click(screen.getByTitle('aiExport.exportMarkdown'));
    expect(onExportAiSession).toHaveBeenCalledTimes(1);
    expect(surfaceClick).not.toHaveBeenCalled();
  });

  it('keeps pin reachable from overflow when compact cards have no extra actions', () => {
    const props = renderActions({ density: 'compact' });

    expect(screen.queryByTitle('card.pin')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('view.more'));
    fireEvent.click(screen.getByTitle('card.pin'));

    expect(props.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('moves reveal into the overflow menu in narrow density', () => {
    const onOpenDir = vi.fn();
    const surfaceClick = vi.fn();
    render(
      <div onClick={surfaceClick}>
        <CardActions
          pinned={false}
          pinFull={false}
          onCopyCwd={vi.fn()}
          onOpenDir={onOpenDir}
          onTogglePin={vi.fn()}
          density="narrow"
        />
      </div>,
    );

    expect(screen.getByTitle('card.copyPath')).toBeInTheDocument();
    expect(screen.queryByTitle('card.revealProject')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('view.more'));
    fireEvent.click(screen.getByTitle('card.revealProject'));

    expect(onOpenDir).toHaveBeenCalledTimes(1);
    expect(surfaceClick).not.toHaveBeenCalled();
  });

  it('renders overflow content inside the compact overflow menu', () => {
    renderActions({
      density: 'compact',
      overflowContent: <button type="button" title="ai-intent-control" />,
    });

    expect(screen.queryByTitle('ai-intent-control')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('view.more'));
    expect(screen.getByTitle('ai-intent-control')).toBeInTheDocument();
  });

  it('adds an independent Workbench action to the wide card menu', () => {
    const onToggleWorkbenchFollow = vi.fn();
    renderActions({
      followedInWorkbench: false,
      onToggleWorkbenchFollow,
    });

    fireEvent.click(screen.getByTitle('view.more'));
    fireEvent.click(screen.getByTitle('card.addToWorkbench'));

    expect(onToggleWorkbenchFollow).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('card.pin')).toBeInTheDocument();
  });

  it('keeps terminal editing available from the wide overflow menu', () => {
    const onEdit = vi.fn();
    renderActions({ onEdit });

    fireEvent.click(screen.getByTitle('view.more'));
    fireEvent.click(screen.getByTitle('edit.action'));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('shows remove wording for an already followed terminal', () => {
    const onToggleWorkbenchFollow = vi.fn();
    renderActions({
      followedInWorkbench: true,
      onToggleWorkbenchFollow,
    });

    fireEvent.click(screen.getByTitle('view.more'));
    fireEvent.click(screen.getByTitle('card.removeFromWorkbench'));

    expect(onToggleWorkbenchFollow).toHaveBeenCalledTimes(1);
  });
});
