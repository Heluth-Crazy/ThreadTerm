import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class LiveGridErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleReset = () => {
    try {
      localStorage.removeItem('openwork-live-grid');
    } catch {
      // ignore
    }
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
            <span className="text-2xl">⚠</span>
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">LiveGrid 出错了</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {this.state.error?.message || '渲染错误'}
            </p>
          </div>
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded-lg border border-border/60 bg-card px-4 py-2 text-xs text-foreground transition-colors hover:bg-muted/60"
          >
            清除数据并重置
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
