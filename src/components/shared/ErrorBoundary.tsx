import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  /** Label shown in the recovery UI, e.g. "Git Panel" or "Terminal". */
  area?: string;
  /** Callback invoked when the user clicks "Retry". */
  onReset?: () => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

const AREA_ICONS: Record<string, string> = {
  'Git Panel': '🔀',
  Terminal: '🖥',
  'File Tree': '📁',
  Chat: '💬',
  'Live Grid': '📊',
};

/**
 * Reusable ErrorBoundary for any feature area.
 *
 * Renders a recovery UI with the area name, an icon, the error message,
 * and a "Retry" button that resets the boundary (and optionally calls `onReset`).
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.area ? `: ${this.props.area}` : ''}]`, error, info);
  }

  resetErrorBoundary = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      const area = this.props.area ?? 'this section';
      const icon = (this.props.area && AREA_ICONS[this.props.area]) || '⚠';

      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <span className="text-2xl">{icon}</span>
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              Something went wrong in {area}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
          </div>
          <button
            type="button"
            onClick={this.resetErrorBoundary}
            className="rounded-lg border border-border/60 bg-card px-4 py-2 text-xs text-foreground transition-colors hover:bg-muted/60"
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
