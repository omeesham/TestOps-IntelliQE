/**
 * RequirementsManagementPage — the /requirements route.
 *
 * The full-page home for the requirement lifecycle: fetch & analyse BRD / FRD
 * documents, review them, map them to APIs, see generated test cases and trace
 * coverage. It wears the app's own chrome (global sidebar + header) and renders
 * the shared RequirementsDashboard body beneath a page title, mirroring the
 * reference layout. Opening the Test Case Generation hand-off returns to the API
 * Automation pipeline.
 */
import { useNavigate } from 'react-router-dom';
import RequirementsDashboard from '@/components/api-studio/requirements/RequirementsDashboard';

export default function RequirementsManagementPage() {
  const navigate = useNavigate();
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-4 sm:px-6 pt-6 pb-1 flex-shrink-0">
        <h1 className="text-2xl font-bold text-[#1E1B4B]">Requirements Management</h1>
        <p className="text-sm text-gray-500 mt-0.5">Fetch and analyze BRD / FRD documents to generate API test cases</p>
      </div>
      <RequirementsDashboard onClose={() => navigate('/automation')} />
    </div>
  );
}
