import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Loader2, Video, ChevronDown, FileText, Clock, CheckCircle2, XCircle,
  CircleSlash, Film, Timer, AlertTriangle, Play, Pause, RotateCcw,
  Maximize2, Minimize2, Gauge, ListFilter, Trash2,
} from 'lucide-react';
import {
  getRecordingRuns, getRecordingForRun, recordExecutionForRun, getRecordingFrames,
  deleteRecordingEntry,
  type RecordingRun, type ExecutionRecording, type RecordedTest, type FrameBundle,
} from '@/services/api';
import ErrorAlert from '@/components/feedback/ErrorAlert';
import { normalizeError, type NormalizedError } from '@/utils/apiError';

type StatusFilter = 'all' | 'passed' | 'failed';
type RunScope = 'all' | 'passed' | 'failed';

/** Format a millisecond duration as a compact human string: 1m 05s / 2.4s / 320ms. */
function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** mm:ss.s clock for the player scrubber. */
function clock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = (s % 60).toFixed(1);
  return `${m}:${r.padStart(4, '0')}`;
}

const STATUS_META: Record<RecordedTest['status'], { label: string; cls: string; Icon: React.ElementType }> = {
  passed: { label: 'Passed', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: CheckCircle2 },
  failed: { label: 'Failed', cls: 'bg-rose-50 text-rose-700 border-rose-200', Icon: XCircle },
  not_run: { label: 'Not run', cls: 'bg-gray-50 text-gray-600 border-gray-200', Icon: CircleSlash },
};

function StatChip({ icon: Icon, label, value, tone = 'default' }: {
  icon: React.ElementType; label: string; value: string;
  tone?: 'default' | 'good' | 'bad';
}) {
  const toneCls =
    tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-700' : 'text-[#1E3A8A]';
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-[#EEF4FF] border border-[#C5D6FF] rounded-lg">
      <Icon className="w-4 h-4 text-[#2143A8] flex-shrink-0" />
      <div className="leading-tight">
        <div className={`text-sm font-semibold ${toneCls}`}>{value}</div>
        <div className="text-[10px] uppercase tracking-wide text-[#6B7280]">{label}</div>
      </div>
    </div>
  );
}

// Playback rates. 1× is real-time ("Normal"); ordered so the first click from
// Normal slows down (for fast tests) before offering 2×.
const SPEEDS = [1, 0.5, 0.25, 2];

/** Canvas player that flips through captured JPEG frames at their real offsets. */
function FramePlayer({ bundle }: { bundle: FrameBundle }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const rafRef = useRef<number | null>(null);
  const startWallRef = useRef(0);
  const baseMsRef = useRef(0);
  const speedRef = useRef(1);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const duration = bundle.durationMs || (bundle.frames.length ? bundle.frames[bundle.frames.length - 1].tMs : 0);

  // Preload all frames as Image objects once.
  useEffect(() => {
    imagesRef.current = bundle.frames.map((f) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${f.jpg}`;
      return img;
    });
  }, [bundle]);

  const frameIndexAt = useCallback((tMs: number) => {
    const frames = bundle.frames;
    let idx = 0;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].tMs <= tMs) idx = i; else break;
    }
    return idx;
  }, [bundle]);

  const draw = useCallback((tMs: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = imagesRef.current[frameIndexAt(tMs)];
    if (!img) return;
    const render = () => {
      if (!img.naturalWidth) return;
      if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth;
      if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    if (img.complete && img.naturalWidth) render();
    else img.onload = render;
  }, [frameIndexAt]);

  // Draw the first frame on mount.
  useEffect(() => { draw(0); setCurrentMs(0); }, [draw]);

  const stop = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }, []);

  // Current playback position computed from the wall clock + active speed.
  const positionMs = useCallback(
    () => baseMsRef.current + (performance.now() - startWallRef.current) * speedRef.current,
    [],
  );

  const tick = useCallback(() => {
    const t = positionMs();
    if (t >= duration) {
      setCurrentMs(duration); draw(duration); setPlaying(false); stop();
      return;
    }
    setCurrentMs(t); draw(t);
    rafRef.current = requestAnimationFrame(tick);
  }, [duration, draw, stop, positionMs]);

  const play = useCallback(() => {
    if (!bundle.frames.length) return;
    baseMsRef.current = currentMs >= duration ? 0 : currentMs;
    startWallRef.current = performance.now();
    setPlaying(true);
    rafRef.current = requestAnimationFrame(tick);
  }, [bundle, currentMs, duration, tick]);

  const pause = useCallback(() => { setPlaying(false); stop(); }, [stop]);

  useEffect(() => () => stop(), [stop]); // cleanup on unmount

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    pause();
    const t = Number(e.target.value);
    setCurrentMs(t); draw(t);
  };

  // Change playback speed; re-anchor so play continues smoothly from here.
  const cycleSpeed = useCallback(() => {
    const idx = SPEEDS.indexOf(speedRef.current);
    const next = SPEEDS[(idx + 1) % SPEEDS.length] ?? 1;
    if (rafRef.current != null) {
      baseMsRef.current = Math.min(positionMs(), duration);
      startWallRef.current = performance.now();
    }
    speedRef.current = next;
    setSpeed(next);
  }, [duration, positionMs]);

  // Track fullscreen state (covers Esc / browser-chrome exit too).
  useEffect(() => {
    const onFs = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // Decide enter-vs-exit relative to THIS player's element (not the global
    // fullscreenElement, which is truthy when any other player is fullscreen).
    // Both calls return promises that can reject (e.g. blocked by browser policy);
    // swallow so it never surfaces as an unhandled rejection.
    if (document.fullscreenElement === el) Promise.resolve(document.exitFullscreen?.()).catch(() => {});
    else Promise.resolve(el.requestFullscreen?.()).catch(() => {});
  }, []);

  const atEnd = currentMs >= duration;

  return (
    <div
      ref={containerRef}
      className={`flex flex-col bg-black ${isFullscreen ? 'w-screen h-screen justify-center' : ''}`}
    >
      <div className={`bg-black flex items-center justify-center ${isFullscreen ? 'flex-1 min-h-0' : 'aspect-video'}`}>
        <canvas ref={canvasRef} className="w-full h-full object-contain" />
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5 bg-[#1E3A8A]">
        <button
          onClick={playing ? pause : play}
          className="w-7 h-7 rounded-md bg-white/10 hover:bg-white/20 text-white flex items-center justify-center flex-shrink-0"
          title={playing ? 'Pause' : atEnd ? 'Replay' : 'Play'}
        >
          {playing ? <Pause className="w-3.5 h-3.5" /> : atEnd ? <RotateCcw className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
        <input
          type="range" min={0} max={Math.max(1, duration)} value={Math.min(currentMs, duration)}
          onChange={onSeek}
          className="flex-1 h-1 accent-[#3366FF] cursor-pointer"
        />
        <span className="text-[11px] text-[#AEC4F5] tabular-nums flex-shrink-0">
          {clock(currentMs)} / {clock(duration)}
        </span>
        <button
          onClick={cycleSpeed}
          className="h-6 px-1.5 rounded bg-white/10 hover:bg-white/20 text-[11px] text-white tabular-nums flex items-center gap-1 flex-shrink-0"
          title={`Playback speed: ${speed === 1 ? 'Normal (1×)' : speed + '×'} — click to change`}
        >
          <Gauge className="w-3 h-3" />{speed === 1 ? '1×' : `${speed}×`}
        </button>
        <button
          onClick={toggleFullscreen}
          className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 text-white flex items-center justify-center flex-shrink-0"
          title={isFullscreen ? 'Exit full screen' : 'Full screen'}
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

function RecordingCard({ runId, test, index, onDelete }: {
  runId: string; test: RecordedTest; index: number;
  onDelete: () => Promise<void> | void;
}) {
  const meta = STATUS_META[test.status];
  const [bundle, setBundle] = useState<FrameBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadAndPlay = useCallback(async () => {
    if (!test.framesFile || loading) return;
    setLoading(true);
    setLoadError(false);
    try {
      const b = await getRecordingFrames(runId, test.framesFile);
      setBundle(b);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [runId, test.framesFile, loading]);

  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      // Component usually unmounts on success; guard for the error path.
      setDeleting(false);
      setConfirming(false);
    }
  }, [onDelete]);

  return (
    <div className="bg-white rounded-xl border border-[#C5D6FF]/60 overflow-hidden shadow-sm flex flex-col">
      {bundle ? (
        <FramePlayer bundle={bundle} />
      ) : (
        <button
          onClick={loadAndPlay}
          disabled={!test.framesFile || loading}
          className="relative bg-black aspect-video flex items-center justify-center group disabled:cursor-default"
        >
          {test.posterJpg ? (
            <img
              src={`data:image/jpeg;base64,${test.posterJpg}`}
              alt={test.title}
              className="w-full h-full object-contain opacity-80 group-hover:opacity-100 transition-opacity"
            />
          ) : (
            <div className="flex flex-col items-center text-white/50 text-xs gap-2">
              <Film className="w-8 h-8" />
              No recording captured
            </div>
          )}
          {test.framesFile && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="w-12 h-12 rounded-full bg-black/50 group-hover:bg-[#3366FF]/80 flex items-center justify-center transition-colors">
                {loading ? <Loader2 className="w-6 h-6 text-white animate-spin" /> : <Play className="w-6 h-6 text-white ml-0.5" />}
              </span>
            </span>
          )}
        </button>
      )}

      <div className="p-3 flex-1 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {test.tcNumber && (
                <span className="px-1.5 py-0.5 bg-[#DCE7FF] text-[#2143A8] rounded text-[11px] font-mono">
                  {test.tcNumber}
                </span>
              )}
              <span className="text-[11px] text-[#6B7280]">#{index + 1}</span>
            </div>
            <p className="text-sm font-medium text-[#1E3A8A] mt-1 line-clamp-2" title={test.title}>
              {test.title}
            </p>
          </div>
          <span className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium flex-shrink-0 ${meta.cls}`}>
            <meta.Icon className="w-3 h-3" />
            {meta.label}
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs text-[#6B7280] mt-auto">
          <span className="flex items-center gap-1.5">
            <Timer className="w-3.5 h-3.5 text-[#2143A8]" />
            <span className="font-medium text-[#1E3A8A]">{formatDuration(test.durationMs)}</span>
          </span>
          {test.frameCount > 0 && (
            <span className="flex items-center gap-1.5 text-[#6B7280]">
              <Film className="w-3.5 h-3.5" />
              {test.frameCount} frames
            </span>
          )}
        </div>

        {loadError && (
          <p className="text-[11px] text-rose-600">Couldn’t load this recording. Try again.</p>
        )}
        {test.error && (
          <p className="text-[11px] text-rose-600 bg-rose-50 border border-rose-100 rounded-md px-2 py-1 line-clamp-3" title={test.error}>
            {test.error}
          </p>
        )}

        {/* Delete control — two-step confirm so a click can't lose a recording. */}
        <div className="flex justify-end pt-1 border-t border-[#EEF4FF] mt-1">
          {confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-[#6B7280]">Delete this recording?</span>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                Delete
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="px-2 py-1 text-[11px] font-medium rounded-md text-[#6B7280] hover:bg-[#EEF4FF] disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              title="Delete this recording from the list"
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md text-[#6B7280] hover:text-rose-600 hover:bg-rose-50 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ExecutionRecordingsPage() {
  const [runs, setRuns] = useState<RecordingRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [showRunDropdown, setShowRunDropdown] = useState(false);

  const [recording, setRecording] = useState<ExecutionRecording | null>(null);
  const [loadingRecording, setLoadingRecording] = useState(false);
  const [running, setRunning] = useState(false);
  const [runScope, setRunScope] = useState<RunScope | null>(null);
  const [recError, setRecError] = useState<NormalizedError | null>(null);

  // View filter — show all / only passed / only failed recordings.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Live elapsed timer shown while a recording run is in progress.
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const { runs: list } = await getRecordingRuns();
      setRuns(list);
      if (list.length > 0) {
        setSelectedRunId((prev) => prev || list[0].id);
      }
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // Load any existing recording whenever the selected run changes.
  useEffect(() => {
    if (!selectedRunId) { setRecording(null); return; }
    let cancelled = false;
    setLoadingRecording(true);
    setRecError(null);
    getRecordingForRun(selectedRunId)
      .then((res) => { if (!cancelled) setRecording(res.exists ? res.recording! : null); })
      .catch(() => { if (!cancelled) setRecording(null); })
      .finally(() => { if (!cancelled) setLoadingRecording(false); });
    return () => { cancelled = true; };
  }, [selectedRunId]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // Record the whole run ('all') or just the passed/failed subset. A subset run
  // merges into the existing recording, keeping the tests it didn't re-run.
  const handleRecord = useCallback(async (scope: RunScope = 'all') => {
    if (!selectedRunId || running) return;
    let only: string[] | undefined;
    if (scope !== 'all') {
      if (!recording) return;
      only = recording.tests
        .filter((t) => t.status === scope)
        .map((t) => t.testCaseId || t.tcNumber)
        .filter((x): x is string => !!x);
      if (!only.length) return; // nothing to run for this subset
    }
    setRunning(true);
    setRunScope(scope);
    setRecError(null);
    setElapsed(0);
    const startedAt = Date.now();
    timerRef.current = setInterval(() => setElapsed(Date.now() - startedAt), 250);
    try {
      const { recording: rec } = await recordExecutionForRun(selectedRunId, only);
      setRecording(rec);
      loadRuns(); // refresh the hasRecording flags
    } catch (err) {
      setRecError(normalizeError(err));
    } finally {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setRunning(false);
      setRunScope(null);
    }
  }, [selectedRunId, running, recording, loadRuns]);

  // Delete one test's recording from the list. Updates state with the merged
  // result (or clears it when that was the last recording for the run).
  const handleDelete = useCallback(async (test: RecordedTest) => {
    if (!recording) return;
    const id = test.testCaseId || test.tcNumber || test.title;
    try {
      const res = await deleteRecordingEntry(recording.runId, id);
      setRecording(res.exists ? (res.recording as ExecutionRecording) : null);
      loadRuns(); // refresh the hasRecording flags
    } catch (err) {
      setRecError(normalizeError(err));
    }
  }, [recording, loadRuns]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-[#2143A8] animate-spin" />
        <span className="ml-3 text-sm text-[#6B7280]">Loading runs…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto py-10">
        <ErrorAlert
          error={{ code: 'LOAD_FAIL', title: 'Could not load runs', message: error, severity: 'error', retryable: true }}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const selectedRun = runs.find((r) => r.id === selectedRunId);
  const selectedRunLabel = selectedRun
    ? selectedRun.storyKey || selectedRun.storyTitle || selectedRunId.slice(0, 8)
    : 'Select a run';

  const filteredTests = recording
    ? recording.tests.filter((t) => statusFilter === 'all' || t.status === statusFilter)
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#3366FF] to-[#2645D6] flex items-center justify-center shadow-md shadow-purple-200">
          <Video className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-[#1E3A8A]">Execution Recordings</h1>
          <p className="text-sm text-[#6B7280]">
            Replay how each test executed in the browser, with per-test and total run timing.
          </p>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="relative z-50 bg-white/80 backdrop-blur-sm rounded-xl border border-[#C5D6FF]/60 p-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          {/* Run Selector */}
          <div className="relative">
            <button
              onClick={() => setShowRunDropdown(!showRunDropdown)}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-[#EEF4FF] border border-[#C5D6FF] rounded-lg hover:bg-[#DCE7FF] transition-colors min-w-[220px]"
            >
              <FileText className="w-4 h-4 text-[#2143A8]" />
              <span className="text-[#1E3A8A] truncate flex-1 text-left">{selectedRunLabel}</span>
              <ChevronDown className="w-4 h-4 text-[#6B7280]" />
            </button>
            {showRunDropdown && (
              <div className="absolute top-full left-0 mt-1 w-80 bg-white rounded-xl border border-[#C5D6FF] shadow-xl shadow-purple-200/60 z-[100] max-h-72 overflow-y-auto">
                {runs.length === 0 && (
                  <div className="px-3 py-3 text-sm text-[#6B7280]">No test runs yet.</div>
                )}
                {runs.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => { setSelectedRunId(run.id); setShowRunDropdown(false); }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-[#EEF4FF] transition-colors border-t border-[#EEF4FF] ${
                      selectedRunId === run.id ? 'bg-[#DCE7FF] text-[#2143A8] font-medium' : 'text-[#1E3A8A]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {run.storyKey && (
                        <span className="px-1.5 py-0.5 bg-[#DCE7FF] text-[#2143A8] rounded text-xs font-mono">{run.storyKey}</span>
                      )}
                      <span className="truncate flex-1">{run.storyTitle || 'Manual Input'}</span>
                      {run.hasRecording && <Film className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
                    </div>
                    <div className="text-xs text-[#6B7280] mt-0.5">
                      {run.scriptCount} scripts &middot; {new Date(run.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {run.hasRecording && ' · recorded'}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => handleRecord('all')}
            disabled={running || !selectedRunId}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#3366FF] rounded-lg hover:bg-[#2A55D6] disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md shadow-purple-200"
          >
            {running && runScope === 'all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Video className="w-4 h-4" />}
            {running && runScope === 'all' ? 'Recording…' : recording ? 'Re-record All' : 'Record Execution'}
          </button>

          {running && (
            <span className="flex items-center gap-1.5 text-sm text-[#2143A8] font-medium tabular-nums">
              <Clock className="w-4 h-4 animate-pulse" />
              {formatDuration(elapsed)}
            </span>
          )}

          {recording && !running && (
            <span className="text-xs text-[#6B7280] sm:ml-auto">
              Recorded: {new Date(recording.recordedAt).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </span>
          )}
        </div>

        {/* Filter + run-subset row (only once a recording exists) */}
        {recording && !loadingRecording && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-3 pt-3 border-t border-[#DCE7FF]">
            <div className="flex items-center gap-1.5">
              <ListFilter className="w-4 h-4 text-[#6B7280]" />
              <div className="flex rounded-lg border border-[#C5D6FF] overflow-hidden">
                {([
                  ['all', `All (${recording.total})`],
                  ['passed', `Passed (${recording.passed})`],
                  ['failed', `Failed (${recording.failed})`],
                ] as [StatusFilter, string][]).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setStatusFilter(key)}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                      statusFilter === key ? 'bg-[#3366FF] text-white' : 'bg-white text-[#6B7280] hover:bg-[#EEF4FF]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Run the failed / passed subsets separately. */}
            <div className="flex items-center gap-2 sm:ml-auto">
              <button
                onClick={() => handleRecord('failed')}
                disabled={running || recording.failed === 0}
                title="Re-record only the failed tests"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-rose-200 text-rose-700 bg-rose-50 hover:bg-rose-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {running && runScope === 'failed' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                Run failed ({recording.failed})
              </button>
              <button
                onClick={() => handleRecord('passed')}
                disabled={running || recording.passed === 0}
                title="Re-record only the passed tests"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {running && runScope === 'passed' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                Run passed ({recording.passed})
              </button>
            </div>
          </div>
        )}

        {recError && (
          <div className="mt-3">
            <ErrorAlert error={recError} onDismiss={() => setRecError(null)} onRetry={() => handleRecord('all')} />
          </div>
        )}
      </div>

      {/* Capture-unavailable banner — non-Chromium host. Timing is still valid. */}
      {recording && !loadingRecording && recording.captureUnavailable && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900">
            <p className="font-semibold">Timing captured — screen frames unavailable on this host</p>
            <p className="mt-1 text-amber-800">
              {recording.note ||
                'Screen capture uses the Chromium DevTools Protocol and needs a Chromium-based browser (Edge/Chrome). Confirm PLAYWRIGHT_CHANNEL points to msedge or chrome on the runner host.'}
            </p>
          </div>
        </div>
      )}

      {/* Summary / timing band */}
      {recording && !loadingRecording && (
        <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#C5D6FF]/60 p-4">
          <div className="flex flex-wrap gap-3">
            <StatChip icon={Timer} label="Total run time" value={formatDuration(recording.totalDurationMs)} />
            <StatChip icon={Clock} label="Sum of test time" value={formatDuration(recording.sumTestDurationMs)} />
            <StatChip icon={Film} label="Tests recorded" value={String(recording.total)} />
            <StatChip icon={CheckCircle2} label="Passed" value={String(recording.passed)} tone="good" />
            <StatChip icon={XCircle} label="Failed" value={String(recording.failed)} tone={recording.failed > 0 ? 'bad' : 'default'} />
          </div>
        </div>
      )}

      {/* Body */}
      {running ? (
        <div className="flex flex-col items-center justify-center h-80 bg-white/80 backdrop-blur-sm rounded-xl border border-[#C5D6FF]/60">
          <Loader2 className="w-8 h-8 text-[#2143A8] animate-spin mb-4" />
          <h3 className="text-lg font-semibold text-[#1E3A8A] mb-1">
            {runScope === 'failed' ? 'Recording failed tests…' : runScope === 'passed' ? 'Recording passed tests…' : 'Recording execution…'}
          </h3>
          <p className="text-sm text-[#6B7280] max-w-md text-center">
            Running the {runScope === 'all' ? 'saved Playwright scripts' : `${runScope} tests`} with screen capture. This can take a few minutes.
          </p>
          <span className="mt-3 text-sm text-[#2143A8] font-medium tabular-nums">{formatDuration(elapsed)} elapsed</span>
        </div>
      ) : loadingRecording ? (
        <div className="flex items-center justify-center h-64 bg-white/80 backdrop-blur-sm rounded-xl border border-[#C5D6FF]/60">
          <Loader2 className="w-8 h-8 text-[#2143A8] animate-spin" />
          <span className="ml-3 text-sm text-[#6B7280]">Loading recording…</span>
        </div>
      ) : recording && recording.tests.length > 0 ? (
        filteredTests.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredTests.map((test, i) => (
              // Key by STABLE identity (not filtered index) so toggling the filter
              // doesn't remount cards and reset a loaded/playing recording.
              <RecordingCard
                key={test.testCaseId || test.tcNumber || test.title}
                runId={recording.runId}
                test={test}
                index={i}
                onDelete={() => handleDelete(test)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-64 bg-white/80 backdrop-blur-sm rounded-xl border border-[#C5D6FF]/60">
            <ListFilter className="w-12 h-12 text-[#6B7280] mb-3" />
            <h3 className="text-base font-semibold text-[#1E3A8A] mb-1">No {statusFilter} tests in this recording</h3>
            <button
              onClick={() => setStatusFilter('all')}
              className="mt-2 text-sm font-medium text-[#2143A8] hover:underline"
            >
              Show all tests
            </button>
          </div>
        )
      ) : (
        <div className="flex flex-col items-center justify-center h-80 bg-white/80 backdrop-blur-sm rounded-xl border border-[#C5D6FF]/60">
          <Video className="w-14 h-14 text-[#6B7280] mb-4" />
          <h3 className="text-lg font-semibold text-[#1E3A8A] mb-2">No recording for this run yet</h3>
          <p className="text-sm text-[#6B7280] max-w-md text-center mb-4">
            {selectedRun && selectedRun.scriptCount === 0
              ? 'This run has no automation scripts yet. Generate scripts first, then record an execution.'
              : 'Click "Record Execution" to run the stored Playwright scripts with screen capture and timing.'}
          </p>
          <button
            onClick={() => handleRecord('all')}
            disabled={running || !selectedRunId || (selectedRun?.scriptCount ?? 0) === 0}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-[#3366FF] rounded-lg hover:bg-[#2A55D6] disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md shadow-purple-200"
          >
            <Video className="w-4 h-4" />
            Record Execution
          </button>
        </div>
      )}
    </div>
  );
}
