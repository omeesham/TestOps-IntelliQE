import { Lock } from 'lucide-react';

/**
 * Shown in place of a page whose feature has been disabled for the current
 * role from the Feature Toggles dashboard.
 */
export default function FeatureUnavailable({ name }: { name?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center h-full">
      <div className="max-w-md text-center px-6 py-10 rounded-2xl border border-purple-100 bg-white shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-purple-50">
          <Lock className="h-7 w-7 text-[#7C3AED]" />
        </div>
        <h2 className="text-lg font-semibold text-gray-900">
          {name ? `${name} is unavailable` : 'Feature unavailable'}
        </h2>
        <p className="mt-2 text-sm text-gray-500">
          This feature has been disabled for your role by an administrator. If you
          think you need access, please contact your workspace admin.
        </p>
      </div>
    </div>
  );
}
