import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResumeLoadingOverlay } from './ResumeLoadingOverlay';

describe('ResumeLoadingOverlay', () => {
  it('shows one stable percentage without exposing internal stage names', () => {
    const { rerender } = render(
      <ResumeLoadingOverlay
        label="Restoring history"
        progress={67}
        visible={true}
      />,
    );

    const overlay = screen.getByTestId('resume-loading-overlay');
    expect(overlay).toHaveTextContent(
      'Restoring history',
    );
    expect(overlay).toHaveTextContent('67%');
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '67',
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'data-state',
      'determinate',
    );
    expect(overlay).toBeVisible();

    rerender(
      <ResumeLoadingOverlay
        label="Restoring history"
        progress={100}
        visible={false}
      />,
    );
    expect(overlay).not.toBeVisible();
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
  });
});
