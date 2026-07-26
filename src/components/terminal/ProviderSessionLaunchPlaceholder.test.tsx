import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderSessionLaunchPlaceholder } from './ProviderSessionLaunchPlaceholder';

describe('ProviderSessionLaunchPlaceholder', () => {
  it('shows progress while history is being resolved', () => {
    render(
      <ProviderSessionLaunchPlaceholder status="checking" onRetry={vi.fn()} />,
    );

    expect(screen.getByTestId('provider-session-validation')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers retry without claiming that a new session was started', () => {
    const onRetry = vi.fn();
    render(
      <ProviderSessionLaunchPlaceholder
        status="unavailable"
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('provider-session-validation')).toHaveAttribute(
      'aria-busy',
      'false',
    );
  });
});
