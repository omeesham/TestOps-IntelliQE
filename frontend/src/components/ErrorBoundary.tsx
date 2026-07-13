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
import { AlertOctagon, RefreshCw, Copy } from 'lucide-react';
import { log } from '@/utils/logger';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  sessionId: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, sessionId: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Funnel render crashes through the central logger so they appear in the
    // Diagnostics panel (with the breadcrumb trail that led here) and ship to
    // the backend sink — not just an ephemeral console.error.
    log.error('render', `React render crash: ${error.message}`, {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
    this.setState({ componentStack: info.componentStack ?? null, sessionId: log.getSessionId() });
  }

  private handleCopy = () => {
    try { navigator.clipboard.writeText(JSON.stringify(log.exportBundle(), null, 2)); }
    catch { log.download(); }
  };

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
      <div className="min-h-screen flex items-center justify-center bg-[#F5F3FF] p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-red-200 shadow-lg p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center">
              <AlertOctagon className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-[#1E1B4B]">Something went wrong</h1>
              <p className="text-xs text-[#6B7280]">The page hit an unexpected error.</p>
            </div>
          </div>

          <p className="text-sm text-[#6B7280] mb-4">
            We&rsquo;ve logged the issue. Try reloading the page; if it keeps happening, contact support
            {this.state.sessionId && <> with the diagnostic id below</>}.
          </p>

          {this.state.sessionId && (
            <div className="mb-5 flex items-center justify-between gap-2 px-3 py-2 bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-[#7C3AED] font-semibold">Diagnostic id</p>
                <p className="text-xs font-mono text-[#1E1B4B] truncate select-all">{this.state.sessionId}</p>
              </div>
              <button
                onClick={this.handleCopy}
                className="flex-shrink-0 px-2 py-1 text-xs font-medium text-[#7C3AED] border border-[#DDD6FE] rounded-md hover:bg-white inline-flex items-center gap-1"
              >
                <Copy className="w-3 h-3" /> Copy report
              </button>
            </div>
          )}

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
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-[#7C3AED] rounded-lg hover:bg-[#6D28D9] inline-flex items-center justify-center gap-1.5"
            >
              <RefreshCw className="w-4 h-4" /> Reload
            </button>
            <button
              onClick={this.handleHome}
              className="px-4 py-2 text-sm font-medium text-[#7C3AED] border border-[#DDD6FE] rounded-lg hover:bg-[#F5F3FF]"
            >
              Go home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
