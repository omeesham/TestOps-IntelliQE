/**
 * Browser-level instrumentation — installs the global capture points that turn
 * "it failed somewhere" into "this click, on this element, triggered this error".
 *
 * Installs three things (call `installInstrumentation()` once, from main.tsx):
 *
 *   1. window 'error'            — uncaught runtime errors (incl. resource load
 *                                  failures) that the React error boundary can't
 *                                  see because they fire outside render.
 *   2. window 'unhandledrejection' — rejected promises with no .catch (the most
 *                                  common silent failure in async event handlers).
 *   3. capture-phase 'click'     — a lightweight breadcrumb of what the user
 *                                  actually clicked (button/link/role=button or
 *                                  any [data-log] element), so the log right
 *                                  before a failure shows the action that caused it.
 *
 * This is the auto-instrumentation every production observability SDK (Sentry,
 * Datadog RUM, LogRocket) ships — rebuilt here dependency-free.
 */
import { log } from './logger';

let installed = false;

export function installInstrumentation(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  /* 1. Uncaught runtime + resource errors ───────────────────────── */
  window.addEventListener(
    'error',
    (event: ErrorEvent) => {
      // Resource load failures (img/script/link) surface as an Event whose
      // target is the element, with no `.error` — classify them separately.
      const target = event.target as (HTMLElement & { src?: string; href?: string }) | null;
      if (target && (target.src || target.href) && target !== (window as unknown as HTMLElement)) {
        log.warn('global', `Resource failed to load: ${target.tagName?.toLowerCase()}`, {
          src: target.src || target.href,
        });
        return;
      }
      log.error('global', `Uncaught error: ${event.message}`, {
        message: event.message,
        source: event.filename,
        line: event.lineno,
        col: event.colno,
        stack: event.error?.stack,
      });
    },
    true, // capture — also catches resource errors which don't bubble
  );

  /* 2. Unhandled promise rejections ─────────────────────────────── */
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    log.error('global', 'Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : reason,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  /* 3. User-action breadcrumbs (clicks) ─────────────────────────── */
  document.addEventListener(
    'click',
    (event: MouseEvent) => {
      const el = (event.target as HTMLElement | null)?.closest?.(
        'button, a, [role="button"], [data-log]',
      ) as HTMLElement | null;
      if (!el) return;
      log.action(`click: ${describe(el)}`, {
        tag: el.tagName.toLowerCase(),
        label: label(el),
        testId: el.getAttribute('data-testid') || el.getAttribute('data-log') || undefined,
        href: (el as HTMLAnchorElement).href || undefined,
        path: location.pathname,
      });
    },
    true, // capture — record the breadcrumb even if a handler stops propagation
  );

  log.info('app', 'Instrumentation installed', { sessionId: log.getSessionId() });
}

/** A short, human-readable label for a clicked element. */
function label(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 60);
  const title = el.getAttribute('title');
  if (title) return title.trim();
  return '';
}

function describe(el: HTMLElement): string {
  const l = label(el);
  const tag = el.tagName.toLowerCase();
  return l ? `${tag} "${l}"` : tag;
}
