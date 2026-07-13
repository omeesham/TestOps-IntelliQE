/**
 * Records a breadcrumb every time the route changes, so the log trail shows
 * which screen the user was on when something failed. Renders nothing.
 *
 * Must live inside <BrowserRouter>.
 */
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { log } from '@/utils/logger';

export default function RouteBreadcrumbs() {
  const location = useLocation();
  const prev = useRef<string | null>(null);

  useEffect(() => {
    const to = location.pathname + location.search;
    log.action(`navigate: ${to}`, { from: prev.current, to });
    prev.current = to;
  }, [location.pathname, location.search]);

  return null;
}
