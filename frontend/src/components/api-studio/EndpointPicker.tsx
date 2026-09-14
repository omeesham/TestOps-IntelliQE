/**
 * API Studio — the endpoint picker.
 *
 * An imported spec routinely describes dozens of endpoints, and the studio
 * automates one at a time. This is the choice between them: filterable, showing
 * the method and full path, because "GET /v1/users" and "GET /v1/users/{id}"
 * are two different jobs and the path is what tells them apart.
 */
import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { MethodBadge } from './primitives';
import type { ParsedApiEndpoint } from '@/services/api';

interface Props {
  endpoints: ParsedApiEndpoint[];
  onPick: (ep: ParsedApiEndpoint) => void;
  onClose: () => void;
}

export default function EndpointPicker({ endpoints, onPick, onClose }: Props) {
  const [filter, setFilter] = useState('');

  const q = filter.trim().toLowerCase();
  const visible = q
    ? endpoints.filter((ep) => `${ep.method} ${ep.url} ${ep.title}`.toLowerCase().includes(q))
    : endpoints;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[80vh] bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div>
            <div className="text-[13px] font-semibold text-gray-900">Choose an endpoint</div>
            <div className="text-[11px] text-gray-400 mt-0.5">{endpoints.length} found in the imported file</div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-300 hover:text-gray-600" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-2 border-b border-gray-200">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-gray-300 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by method, path or name…"
              autoFocus
              className="w-full pl-8 pr-2 py-1.5 bg-white border border-gray-200 rounded-md text-[12px] outline-none focus:border-[#A5B4FC] focus:ring-2 focus:ring-[#EDE9FE] transition-all"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {visible.map((ep, i) => (
            <button
              key={`${ep.method}-${ep.url}-${i}`}
              type="button"
              onClick={() => onPick(ep)}
              className="w-full flex items-start gap-2 px-4 py-2.5 border-b border-gray-100 hover:bg-[#F5F3FF] transition-colors text-left"
            >
              <MethodBadge method={ep.method} className="mt-0.5" />
              <div className="min-w-0">
                <div className="font-mono text-[11.5px] text-gray-700 break-all">{ep.url}</div>
                <div className="text-[11px] text-gray-400 truncate">{ep.title}</div>
              </div>
            </button>
          ))}
          {visible.length === 0 && (
            <div className="px-4 py-10 text-center text-[12px] text-gray-400">No endpoints match that filter.</div>
          )}
        </div>
      </div>
    </div>
  );
}
