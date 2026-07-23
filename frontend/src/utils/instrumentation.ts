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
      log.action(`click · ${describe(el)}`, {
        event: 'click',
        tag: el.tagName.toLowerCase(),
        label: label(el),
        testId: el.getAttribute('data-testid') || el.getAttribute('data-log') || undefined,
        href: (el as HTMLAnchorElement).href || undefined,
        path: location.pathname,
        position: { x: event.clientX, y: event.clientY },
      });
    },
    true, // capture — record the breadcrumb even if a handler stops propagation
  );

  /* 4. Form-field commits (change) ──────────────────────────────── */
  // Fires on blur for text inputs, and immediately for selects / checkboxes /
  // radios — i.e. every value the user actually committed. Values are captured
  // (never for password / sensitive fields) so a bug report shows what was
  // entered, not just that "something" was.
  document.addEventListener(
    'change',
    (event: Event) => {
      const el = event.target as (HTMLInputElement & HTMLSelectElement) | null;
      if (!el || !isFormField(el)) return;
      const field = fieldName(el);
      const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
      const data: Record<string, unknown> = { event: 'change', field, type, path: location.pathname };

      if (type === 'checkbox' || type === 'radio') {
        data.checked = (el as HTMLInputElement).checked;
        log.action(`change · ${field} → ${(el as HTMLInputElement).checked ? 'on' : 'off'}`, data);
      } else if (isSecret(el, field)) {
        data.value = '(hidden)';
        log.action(`change · ${field} (value hidden)`, data);
      } else {
        const v = String(el.value ?? '');
        data.value = v.length > 120 ? v.slice(0, 120) + '…' : v;
        data.length = v.length;
        log.action(`change · ${field} = "${data.value}"`, data);
      }
    },
    true,
  );

  /* 5. Field focus (debug — off by default, shows the exact path taken) ── */
  document.addEventListener(
    'focusin',
    (event: FocusEvent) => {
      const el = event.target as HTMLElement | null;
      if (!el || !isFormField(el)) return;
      log.debug('input', `focus · ${fieldName(el as HTMLInputElement)}`, {
        event: 'focus',
        field: fieldName(el as HTMLInputElement),
        type: (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase(),
        path: location.pathname,
      });
    },
    true,
  );

  /* 6. Form submissions ─────────────────────────────────────────── */
  document.addEventListener(
    'submit',
    (event: Event) => {
      const form = event.target as HTMLFormElement | null;
      if (!form) return;
      const fields = Array.from(form.elements)
        .filter((el): el is HTMLInputElement => isFormField(el as HTMLElement))
        .map((el) => fieldName(el))
        .filter(Boolean);
      log.action(`submit · form (${fields.length} field${fields.length === 1 ? '' : 's'})`, {
        event: 'submit',
        fields: fields.slice(0, 20),
        path: location.pathname,
      });
    },
    true,
  );

  /* 7. Navigation — SPA route changes via History API + back/forward ── */
  let lastPath = location.pathname + location.search;
  const logNav = (kind: string) => {
    const now = location.pathname + location.search;
    if (now === lastPath) return;
    log.info('nav', `navigate · ${lastPath} → ${now}`, { event: 'navigate', kind, from: lastPath, to: now });
    lastPath = now;
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: unknown[]) {
      const result = (original as (...a: unknown[]) => unknown).apply(this, args);
      queueMicrotask(() => logNav(method));
      return result;
    } as History[typeof method];
  }
  window.addEventListener('popstate', () => logNav('popstate'));
  window.addEventListener('hashchange', () => logNav('hashchange'));

  /* 8. Tab visibility (did the user switch away mid-flow?) ───────── */
  document.addEventListener('visibilitychange', () => {
    log.debug('app', `tab ${document.visibilityState}`, { event: 'visibility', state: document.visibilityState });
  });

  log.info('app', 'Instrumentation installed', {
    sessionId: log.getSessionId(),
    captures: ['clicks', 'field-changes', 'field-focus', 'form-submits', 'navigation', 'visibility', 'errors', 'rejections'],
  });
}

/** True for the user-editable form controls we want to breadcrumb. */
function isFormField(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    return t !== 'hidden';
  }
  return el.isContentEditable;
}

/** Best-effort human name for a field: label → aria → placeholder → name → id. */
function fieldName(el: HTMLInputElement | HTMLElement): string {
  const id = el.getAttribute('id');
  if (id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (lbl?.textContent) return lbl.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  const wrapLabel = el.closest('label');
  if (wrapLabel?.textContent) return wrapLabel.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim().slice(0, 40);
  const ph = el.getAttribute('placeholder');
  if (ph) return ph.trim().slice(0, 40);
  const name = el.getAttribute('name') || el.getAttribute('id');
  if (name) return name.trim().slice(0, 40);
  return el.tagName.toLowerCase();
}

/** Never capture the value of a password or sensitively-named field. */
const SECRET_FIELD_RE = /pass|password|secret|token|apikey|api_key|auth|bearer|credential|pin|otp|cvv|ssn|card/i;
function isSecret(el: HTMLElement, field: string): boolean {
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return true;
  const name = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${field}`;
  return SECRET_FIELD_RE.test(name);
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
