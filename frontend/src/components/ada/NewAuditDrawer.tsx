/**
 * New website audit — the slide-over form on the ADA Compliance page.
 *
 * A URL is the only required field. Optional: sign-in, UX testing (devices and
 * design standard), scope, and a recurring schedule for the same site.
 */
import { useState } from 'react';
import { startAdaScan, cancelAdaScan, getAdaScan, createAdaSchedule } from '@/services/api';
import { Globe, Lock, Loader2, Square, CalendarClock, Layers, Zap } from 'lucide-react';
import Drawer from '@/components/ui/Drawer';
import { UxSetup } from '@/components/ada/UxTesting';
import { useToast } from '@/components/feedback/ToastProvider';
import { errorMessage, errorStatus, ghostBtn, inputCls, primaryBtn, toUtcSlot } from '@/components/ada/shared';
import { CadenceFields } from '@/components/ada/SharedUi';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The audit has started (or the user chose to watch the one already running). */
  onStarted: (scanId: string) => void;
  /** A recurring schedule was saved along with the audit. */
  onScheduleCreated?: () => void;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-xs font-semibold text-[#1E1B4B] uppercase tracking-wide">{title}</h3>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export default function NewAuditDrawer({ open, onClose, onStarted, onScheduleCreated }: Props) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [quickSample, setQuickSample] = useState(false);
  const [checkExternal, setCheckExternal] = useState(true);
  // UX testing: devices are seeded with the server's recommended set by UxSetup.
  const [uxEnabled, setUxEnabled] = useState(true);
  const [uxDevices, setUxDevices] = useState<string[]>([]);
  const [standardId, setStandardId] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [cadence, setCadence] = useState({ frequency: 'weekly' as 'daily' | 'weekly', weekday: 1, hour: 3 });

  const [formError, setFormError] = useState('');
  /** Id of the audit that is already running for this account (from a 409), so the form can stop or open it. */
  const [blockingScanId, setBlockingScanId] = useState<string | null>(null);
  const [stoppingBlocking, setStoppingBlocking] = useState(false);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setFormError(''); setBlockingScanId(null);
    if (!url.trim()) { setFormError('Enter the website address to audit.'); return; }
    setStarting(true);
    try {
      const res = await startAdaScan({
        url: url.trim(),
        username: needsLogin && username ? username : undefined,
        password: needsLogin && password ? password : undefined,
        maxPages: quickSample ? 15 : undefined,
        checkExternalLinks: checkExternal,
        ux: uxEnabled,
        devices: uxEnabled && uxDevices.length ? uxDevices : undefined,
        designStandardId: uxEnabled && standardId ? standardId : undefined,
      });
      if (recurring) {
        try {
          const slot = toUtcSlot(cadence.hour, cadence.frequency === 'weekly' ? cadence.weekday : null);
          await createAdaSchedule({
            url: url.trim(), frequency: cadence.frequency, runHourUtc: slot.runHourUtc, runWeekday: slot.runWeekday,
            maxPages: quickSample ? 15 : undefined,
            checkExternalLinks: checkExternal,
            username: needsLogin && username ? username : undefined,
            password: needsLogin && password ? password : undefined,
          });
          onScheduleCreated?.();
        } catch (err: unknown) {
          // The audit itself is running; only the schedule was not saved.
          toast.warning('The schedule was not saved', errorMessage(err, 'Add it from the Scheduled audits tab.'));
        }
      }
      setUrl(''); setUsername(''); setPassword(''); setNeedsLogin(false); setRecurring(false);
      onStarted(res.scanId);
    } catch (err: unknown) {
      setFormError(errorMessage(err, 'Could not start the audit.'));
      const other = (err as { response?: { data?: { scanId?: string } } } | undefined)?.response?.data?.scanId;
      if (errorStatus(err) === 409 && other) setBlockingScanId(other);
    } finally {
      setStarting(false);
    }
  };

  /** Stop the audit that is blocking a new one, then retry automatically. */
  const stopBlockingAndStart = async () => {
    if (!blockingScanId) return;
    setStoppingBlocking(true);
    try {
      await cancelAdaScan(blockingScanId);
      // The engine needs a moment to finish the current page and persist the partial report.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const p = await getAdaScan(blockingScanId).catch(() => null);
        if (p && p.scan.status !== 'running') break;
      }
      setBlockingScanId(null); setFormError('');
      await start();
    } catch (err: unknown) {
      setFormError(errorMessage(err, 'Could not stop the running audit.'));
    } finally {
      setStoppingBlocking(false);
    }
  };

  const openBlocking = () => {
    if (!blockingScanId) return;
    const id = blockingScanId;
    setBlockingScanId(null); setFormError('');
    onStarted(id);
  };

  const scopeCard = (active: boolean) => `text-left rounded-xl border px-3.5 py-3 transition-colors ${active ? 'border-violet-400 bg-violet-50/70 ring-2 ring-violet-500/10' : 'border-gray-200 bg-white hover:border-violet-200'}`;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New website audit"
      subtitle="Accessibility (WCAG 2.2 AA), broken links, best practices and UX"
      icon={Globe}
      footer={(
        <>
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="button" onClick={start} disabled={starting || stoppingBlocking || !url.trim()} className={primaryBtn}>
            {starting && <Loader2 className="w-4 h-4 animate-spin" />}
            {starting ? 'Starting' : 'Start audit'}
          </button>
        </>
      )}
    >
      <div className="space-y-6">
        <Section title="Website" hint="IntelliQE opens the site in a browser, follows every menu and link, and checks each page it reaches.">
          <div className="relative">
            <Globe className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void start(); }}
              placeholder="www.example.com"
              aria-label="Website address"
              className={inputCls + ' pl-10'}
              autoFocus
            />
          </div>
          <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer select-none pt-1">
            <input type="checkbox" checked={needsLogin} onChange={(e) => setNeedsLogin(e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500" />
            <Lock className={`w-3.5 h-3.5 ${needsLogin ? 'text-violet-500' : 'text-gray-400'}`} />
            The site needs a sign-in
          </label>
          {needsLogin && (
            <div className="grid grid-cols-2 gap-2">
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username or email" className={inputCls} autoComplete="off" />
              <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" className={inputCls} autoComplete="new-password" />
              <p className="col-span-2 text-xs text-gray-500">If the first page is a sign-in form, IntelliQE signs in and audits the pages behind it. Otherwise it audits the public pages.</p>
            </div>
          )}
        </Section>

        <Section title="Scope">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setQuickSample(false)} className={scopeCard(!quickSample)} aria-pressed={!quickSample}>
              <Layers className={`w-4 h-4 mb-1.5 ${!quickSample ? 'text-violet-600' : 'text-gray-400'}`} />
              <p className="text-sm font-semibold text-gray-800">Whole website</p>
              <p className="text-xs text-gray-500 mt-0.5">Every page found from the menus, links and sitemap.</p>
            </button>
            <button type="button" onClick={() => setQuickSample(true)} className={scopeCard(quickSample)} aria-pressed={quickSample}>
              <Zap className={`w-4 h-4 mb-1.5 ${quickSample ? 'text-violet-600' : 'text-gray-400'}`} />
              <p className="text-sm font-semibold text-gray-800">Quick sample</p>
              <p className="text-xs text-gray-500 mt-0.5">The first 15 pages, for a fast first look.</p>
            </button>
          </div>
          <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer pt-1">
            <input type="checkbox" checked={checkExternal} onChange={(e) => setCheckExternal(e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-violet-600" />
            Also check links to other websites
          </label>
        </Section>

        <Section title="UX testing">
          <UxSetup enabled={uxEnabled} onEnabled={setUxEnabled} devices={uxDevices} onDevices={setUxDevices} standardId={standardId} onStandardId={setStandardId} />
        </Section>

        <Section title="Schedule">
          <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3.5 space-y-3">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} className="w-4 h-4 mt-0.5 rounded border-gray-300 text-violet-600" />
              <span>
                <span className="text-sm font-medium text-gray-800 flex items-center gap-1.5"><CalendarClock className="w-3.5 h-3.5 text-violet-500" /> Make recurring</span>
                <span className="block text-xs text-gray-500 mt-0.5">Runs this audit now and again on a schedule, so the report shows how the site changes.</span>
              </span>
            </label>
            {recurring && (
              <>
                <CadenceFields {...cadence} onChange={(p) => setCadence((c) => ({ ...c, ...p }))} />
                <p className="text-xs text-gray-500">Scheduled runs use the website, sign-in and scope above.</p>
              </>
            )}
          </div>
        </Section>

        {formError && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3.5 py-3 space-y-2" role="alert">
            <p>{formError}</p>
            {blockingScanId && (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={openBlocking} disabled={stoppingBlocking} className="px-3 py-1.5 text-xs rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-100 disabled:opacity-50">View progress</button>
                <button type="button" onClick={stopBlockingAndStart} disabled={stoppingBlocking} className="px-3 py-1.5 text-xs rounded-lg bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 flex items-center gap-1.5" title="The running audit keeps its partial report">
                  {stoppingBlocking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3 fill-current" />} {stoppingBlocking ? 'Stopping' : 'Stop it and start this audit'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}
