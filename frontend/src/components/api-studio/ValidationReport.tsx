/**
 * ValidationReport — the shared read-out for the deterministic API checks in
 * apiValidation.ts. One compact card used by both gates:
 *   - inline in the import outcome panel, and
 *   - inside ValidationGateModal, the "proceed anyway" dialog shown when a run
 *     is about to start on endpoints that aren't fully ready.
 */
import { AlertTriangle, XCircle, CheckCircle2, Info, ShieldCheck } from 'lucide-react';
import { PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { ApiValidationReport, ValidationLevel } from './apiValidation';

const LEVEL_ICON = { error: XCircle, warning: AlertTriangle, info: Info } as const;
const LEVEL_TONE: Record<ValidationLevel, string> = {
  error: 'text-red-600',
  warning: 'text-amber-600',
  info: 'text-gray-400',
};

/** Summary line + the first `max` issues, grouped most-severe first. */
export default function ValidationReport({ report, max = 8 }: { report: ApiValidationReport; max?: number }) {
  const { total, ready, errorCount, warningCount, issues } = report;
  const clean = errorCount === 0 && warningCount === 0;

  const ordered = [...issues].sort((a, b) => {
    const rank = { error: 0, warning: 1, info: 2 } as const;
    return rank[a.level] - rank[b.level];
  });
  const shown = ordered.slice(0, max);
  const extra = ordered.length - shown.length;

  return (
    <div className="rounded-lg border border-[#ECE9F8] bg-[#FBFAFE] px-3 py-2.5">
      <div className="flex items-center gap-2">
        {clean
          ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          : errorCount > 0
            ? <XCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
            : <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />}
        <p className="text-[12px] font-semibold text-gray-800">
          {clean
            ? `Validation passed — all ${total} endpoint${total === 1 ? '' : 's'} look automation-ready.`
            : `Validation: ${ready}/${total} ready`}
          {!clean && (
            <span className="font-normal text-gray-500">
              {errorCount > 0 && ` · ${errorCount} error${errorCount === 1 ? '' : 's'}`}
              {warningCount > 0 && ` · ${warningCount} warning${warningCount === 1 ? '' : 's'}`}
            </span>
          )}
        </p>
      </div>

      {!clean && (
        <ul className="mt-2 space-y-1">
          {shown.map((iss, i) => {
            const Icon = LEVEL_ICON[iss.level];
            return (
              <li key={i} className="flex gap-1.5 text-[11px] leading-snug">
                <Icon className={`w-3 h-3 mt-0.5 flex-shrink-0 ${LEVEL_TONE[iss.level]}`} />
                <span className="min-w-0 text-gray-700">
                  {iss.endpointLabel && <span className="font-mono text-gray-500">{iss.endpointLabel}</span>}
                  {iss.endpointLabel && <span className="text-gray-400"> — </span>}
                  {iss.message}
                </span>
              </li>
            );
          })}
          {extra > 0 && <li className="text-[11px] text-gray-400 pl-[18px]">…and {extra} more</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * The generation gate — shown only when the selected endpoints have errors or
 * warnings. "Proceed anyway" is always available (warn, don't block); Cancel
 * returns the user to the catalogue to fix things first.
 */
export function ValidationGateModal({
  report, onProceed, onCancel,
}: { report: ApiValidationReport; onProceed: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-lg bg-white rounded-2xl border border-[#ECE9F8] shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 p-5 border-b border-gray-100">
          <span className="w-9 h-9 rounded-xl bg-[#F5F3FF] border border-[#DDD6FE] flex items-center justify-center flex-shrink-0">
            <ShieldCheck className="w-4.5 h-4.5 text-[#7C3AED]" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-gray-900">Validate before automating</h3>
            <p className="text-[12px] text-gray-500 mt-0.5">
              {report.errorCount > 0
                ? 'Some selected endpoints are not automation-ready. You can still proceed, but these may fail.'
                : 'Some selected endpoints have warnings. Review them, or proceed anyway.'}
            </p>
          </div>
        </div>
        <div className="p-5">
          <ValidationReport report={report} max={12} />
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-gray-100">
          <button type="button" onClick={onCancel} className={SECONDARY_BTN}>Review endpoints</button>
          <button type="button" onClick={onProceed} className={PRIMARY_BTN}>Proceed anyway</button>
        </div>
      </div>
    </div>
  );
}
