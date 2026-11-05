/**
 * IntegrationDashboard — the modal entry point for the Requirements Management
 * surface, opened from the API Automation Tools gallery.
 *
 * It is a thin modal frame around the shared `RequirementsDashboard` body (the
 * same body the full-page `/requirements` route renders). Kept so the Tools
 * gallery keeps its in-place launch; the page is the primary home.
 */
import { X, LayoutDashboard } from 'lucide-react';
import { CARD, STRIP } from './format';
import RequirementsDashboard from './requirements/RequirementsDashboard';

export default function IntegrationDashboard({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-3 sm:p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-7xl h-[94vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2.5 px-4 py-3 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center flex-shrink-0"><LayoutDashboard className="w-4 h-4 text-white" /></span>
          <div className="min-w-0">
            <h2 className="text-[14px] font-bold text-gray-900 leading-tight">Requirements Management</h2>
            <p className="text-[11px] text-gray-500 leading-tight">Fetch and analyze BRD / FRD documents to generate API test cases</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-white/60 flex-shrink-0"><X className="w-4 h-4" /></button>
        </div>
        <RequirementsDashboard onClose={onClose} />
      </div>
    </div>
  );
}
