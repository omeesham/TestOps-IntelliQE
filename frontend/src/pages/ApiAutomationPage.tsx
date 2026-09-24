/**
 * ApiAutomationPage — the /api-automation route.
 *
 * A thin wrapper that mounts the API Automation workspace as a first-class
 * page. The workspace owns its own state and chrome; the global sidebar and
 * top bar (which now names this page) supply the app-level navigation, so no
 * in-page back arrow or second header is needed here.
 */
import ApiStudio from '@/components/api-studio/ApiStudio';

export default function ApiAutomationPage() {
  return <ApiStudio />;
}
