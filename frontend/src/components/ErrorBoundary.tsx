/**
 * Application-level React error boundary.
 *
 * Catches any uncaught exception thrown during render and shows a friendly
 * fallback UI instead of a blank white page. Without this, a single broken
 * component crashes the entire SPA — the standard fix in every production
 * React app.
 */
import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { AlertOctagon, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] Uncaught render error:', error, info);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleHome = () => {
    window.location.href = '/';
  };

  render() {
    if (!this.state.error) return this.props.children;
    const isDev = import.meta.env.MODE !== 'production';

    return (
      <div className="min-h-screen flex items-center justify-center bg-[#EEF4FF] p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-red-200 shadow-lg p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center">
              <AlertOctagon className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-[#1E3A8A]">Something went wrong</h1>
              <p className="text-xs text-[#6B7280]">The page hit an unexpected error.</p>
            </div>
          </div>

          <p className="text-sm text-[#6B7280] mb-5">
            We&rsquo;ve logged the issue. Try reloading the page; if it keeps happening, contact support.
          </p>

          {isDev && (
            <details className="mb-5 text-[11px] font-mono text-red-700 bg-red-50 border border-red-100 rounded p-2">
              <summary className="cursor-pointer">Stack trace (dev only)</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words">{this.state.error.message}</pre>
              {this.state.componentStack && (
                <pre className="mt-2 whitespace-pre-wrap break-words opacity-70">{this.state.componentStack}</pre>
              )}
            </details>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={this.handleReload}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-[#3366FF] rounded-lg hover:bg-[#2A55D6] inline-flex items-center justify-center gap-1.5"
            >
              <RefreshCw className="w-4 h-4" /> Reload
            </button>
            <button
              onClick={this.handleHome}
              className="px-4 py-2 text-sm font-medium text-[#2143A8] border border-[#C5D6FF] rounded-lg hover:bg-[#EEF4FF]"
            >
              Go home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
