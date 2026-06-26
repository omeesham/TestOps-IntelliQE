import { useState } from 'react';
import { X, Plug, Loader2, Eye, EyeOff } from 'lucide-react';
import type { CatalogItem } from './integrationCatalog';

interface Props {
  integration: CatalogItem;
  saving: boolean;
  error: string;
  onSave: (formData: Record<string, string>) => void;
  onClose: () => void;
}

export default function ConnectModal({ integration, saving, error, onSave, onClose }: Props) {
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [visibleFields, setVisibleFields] = useState<Set<string>>(new Set());

  const toggleVisibility = (key: string) => {
    setVisibleFields(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600">
          <X className="w-5 h-5" />
        </button>
        <h3 className="text-lg font-bold text-[#1E3A8A] mb-1">Connect {integration.name}</h3>
        <p className="text-xs text-[#6B7280] mb-5">{integration.category}</p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600">{error}</div>
        )}

        <div className="space-y-4">
          {integration.fields.map((field) => (
            <div key={field.key}>
              <label className="block text-xs font-medium text-[#6B7280] mb-1">{field.label}</label>
              <div className="relative">
                <input
                  type={field.type === 'password' && !visibleFields.has(field.key) ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={formData[field.key] || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, [field.key]: e.target.value }))}
                  autoComplete="off"
                  className="w-full px-3 py-2 border border-[#C5D6FF] rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#3366FF]/20 focus:border-[#3366FF] pr-10"
                />
                {field.type === 'password' && (
                  <button
                    type="button"
                    onClick={() => toggleVisibility(field.key)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#2143A8] transition-colors"
                  >
                    {visibleFields.has(field.key) ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B7280] hover:bg-gray-100 rounded-lg transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onSave(formData)}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-[#3366FF] to-[#2645D6] text-white rounded-lg text-sm font-medium hover:from-[#2A55D6] hover:to-[#2645D6] shadow-md shadow-purple-500/20 transition-all disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
            {saving ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
