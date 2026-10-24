import { useEffect, useRef, useState, useCallback } from 'react';
import { Upload, Trash2, Loader2, FileText } from 'lucide-react';
import { listTestFiles, uploadTestFiles, deleteTestFile, type TestFile } from '@/services/api';

interface Props {
  /** Application Setup id of a saved application. */
  appId: string;
}

const MAX_FILE_MB = 25;

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Files that upload tests use (documents, images…). Generated test cases and
 * scripts refer to them by name; invalid files for negative upload tests are
 * generated automatically at run time.
 */
export default function TestFilesSection({ appId }: Props) {
  const [files, setFiles] = useState<TestFile[]>([]);
  const [negative, setNegative] = useState<{ name: string; description: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await listTestFiles(appId);
      setFiles(res.files);
      setNegative(res.negativeFiles);
    } catch {
      setMessage({ kind: 'error', text: 'Could not load test files.' });
    }
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const onPick = async (list: FileList | null) => {
    if (!list?.length) return;
    const chosen = Array.from(list);
    const tooBig = chosen.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024).map((f) => f.name);
    if (tooBig.length) {
      setMessage({ kind: 'error', text: `Over ${MAX_FILE_MB} MB: ${tooBig.join(', ')}` });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await uploadTestFiles(appId, chosen);
      const rejected = res.rejected.map((r) => `${r.name} (${r.reason})`).join('; ');
      setMessage(rejected
        ? { kind: 'error', text: `Saved ${res.saved.length}. Not saved: ${rejected}` }
        : { kind: 'info', text: `Saved ${res.saved.length} file(s).` });
      await load();
    } catch (err) {
      const text = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setMessage({ kind: 'error', text: text || 'Upload failed.' });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDelete = async (name: string) => {
    if (!window.confirm(`Delete the test file "${name}"?`)) return;
    try {
      await deleteTestFile(appId, name);
      await load();
    } catch (err) {
      const text = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setMessage({ kind: 'error', text: text || 'Delete failed.' });
    }
  };

  return (
    <div className="border-t border-[#DCE7FF] pt-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm font-medium text-[#1E3A8A]">Test files</p>
          <p className="text-xs text-[#6B7280]">Files that upload tests use (all environments of this app). Up to {MAX_FILE_MB} MB each.</p>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#2143A8] bg-[#EEF4FF] hover:bg-[#DCE7FF] rounded-lg border border-[#C5D6FF]/60 transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          Upload files
        </button>
        <input ref={inputRef} type="file" multiple className="hidden" aria-label="Upload test files" onChange={(e) => onPick(e.target.files)} />
      </div>

      {message && (
        <p className={`mb-2 text-xs ${message.kind === 'error' ? 'text-red-600' : 'text-[#2143A8]'}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}

      {files.length === 0 ? (
        <p className="text-xs text-[#6B7280] py-2">No test files yet. Upload the files your upload screens need, e.g. sample documents or images.</p>
      ) : (
        <ul className="divide-y divide-[#DCE7FF] border border-[#C5D6FF]/60 rounded-xl bg-white" aria-label="Test files">
          {files.map((f) => (
            <li key={f.name} className="flex items-center justify-between px-3 py-2">
              <span className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-[#2143A8] flex-shrink-0" />
                <span className="text-sm text-[#1E3A8A] truncate">{f.name}</span>
                <span className="text-[11px] text-[#6B7280] flex-shrink-0">{formatSize(f.size)}</span>
              </span>
              <button
                type="button"
                onClick={() => onDelete(f.name)}
                className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"
                aria-label={`Delete ${f.name}`}
                title="Delete file"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && negative.length > 0 && (
        <p className="mt-2 text-[11px] text-[#6B7280]">
          Also available automatically for negative tests: {negative.map((n) => n.name).join(', ')}.
        </p>
      )}
    </div>
  );
}
