/**
 * DbValidate — read-only SELECT assertions against a database.
 *
 * Saves tenant-scoped connections (mssql / postgres / mysql, password encrypted
 * at rest) and runs a single read-only query against one of them, grading the
 * result against simple expectations — row-count bounds and a column-equals
 * check — so a run can assert on the data behind an API, not just its response.
 * Writes are rejected server-side; only SELECT / WITH queries are accepted.
 */
import { useEffect, useState } from 'react';
import { X, Database, Play, Plus, Trash2, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listDbConnections, saveDbConnection, deleteDbConnection, runDbValidation,
  type DbConnection, type DbValidateResult,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN, formatDuration } from './format';

type Dialect = 'mssql' | 'postgres' | 'mysql';

export default function DbValidate({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Add form
  const [name, setName] = useState('');
  const [dialect, setDialect] = useState<Dialect>('mssql');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState('');
  const [enc, setEnc] = useState(false);

  // Validate
  const [connectionId, setConnectionId] = useState('');
  const [query, setQuery] = useState('');
  const [minRows, setMinRows] = useState('');
  const [maxRows, setMaxRows] = useState('');
  const [column, setColumn] = useState('');
  const [equals, setEquals] = useState('');
  const [result, setResult] = useState<DbValidateResult | null>(null);

  const load = async (selectId?: string) => {
    const { connections: list } = await listDbConnections();
    setConnections(list);
    if (selectId) setConnectionId(selectId);
    else if (!list.some((c) => c.id === connectionId)) setConnectionId(list[0]?.id || '');
  };

  useEffect(() => {
    (async () => {
      try { await load(); }
      catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Could not load connections.'); }
      finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const { connection } = await saveDbConnection({
        name: name.trim(),
        dialect,
        host: host.trim(),
        port: port.trim() ? Number(port) : undefined,
        user: user.trim(),
        password,
        database: database.trim(),
        encrypt: enc,
        ssl: enc,
      });
      setName(''); setHost(''); setPort(''); setUser(''); setPassword(''); setDatabase(''); setEnc(false);
      await load(connection.id);
      toast.success('Connection saved', connection.name);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save the connection.');
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true); setError('');
    try {
      await deleteDbConnection(id);
      await load();
      toast.success('Connection removed');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not delete the connection.');
    } finally { setBusy(false); }
  };

  const validate = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const expect: { minRows?: number; maxRows?: number; column?: string; equals?: string } = {};
      if (minRows.trim() !== '') expect.minRows = Number(minRows);
      if (maxRows.trim() !== '') expect.maxRows = Number(maxRows);
      if (column.trim() !== '') expect.column = column.trim();
      if (equals.trim() !== '') expect.equals = equals.trim();
      setResult(await runDbValidation({
        connectionId,
        query,
        expect: Object.keys(expect).length ? expect : undefined,
      }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Validation failed.');
    } finally { setBusy(false); }
  };

  const previewRows = result ? result.rows.slice(0, 20) : [];
  const previewCols = previewRows.length ? Object.keys(previewRows[0]) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Database className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Database validation</h3>
          <span className="text-[11px] text-gray-400">read-only SELECT assertions</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* ── Connections ── */}
          <div>
            <label className={LABEL}>Connections</label>
            {loading ? (
              <div className="flex items-center justify-center py-6 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
            ) : connections.length === 0 ? (
              <div className="text-center py-4 text-[12px] text-gray-400">No connections yet — add one below.</div>
            ) : (
              <div className="space-y-1.5">
                {connections.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 text-[11.5px] rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] px-3 py-2">
                    <span className="font-semibold text-gray-800">{c.name}</span>
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]">{c.dialect}</span>
                    <span className="text-gray-500 font-mono truncate min-w-0">{c.user}@{c.host}/{c.database}</span>
                    <button type="button" onClick={() => void remove(c.id)} disabled={busy} className="ml-auto p-1 rounded text-gray-400 hover:text-red-500 disabled:opacity-40"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Add connection ── */}
          <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-2">
            <label className={LABEL}>Add connection</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" className={`${INPUT} py-1`} />
              <select value={dialect} onChange={(e) => setDialect(e.target.value as Dialect)} className={`${INPUT} py-1`}>
                <option value="mssql">mssql</option>
                <option value="postgres">postgres</option>
                <option value="mysql">mysql</option>
              </select>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="host" className={`${INPUT} py-1`} />
              <input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="port" className={`${INPUT} py-1`} />
              <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="user" className={`${INPUT} py-1`} />
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" className={`${INPUT} py-1`} />
              <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="database" className={`${INPUT} py-1`} />
            </div>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
                <input type="checkbox" checked={enc} onChange={(e) => setEnc(e.target.checked)} className="w-3.5 h-3.5" />
                encrypt / ssl
              </label>
              <button type="button" onClick={() => void save()} disabled={busy || !name.trim() || !host.trim()} className={SECONDARY_BTN}>
                {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Save connection
              </button>
            </div>
          </div>

          {/* ── Validate ── */}
          <div className="space-y-2">
            <label className={LABEL}>Validate</label>
            <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className={INPUT} disabled={!connections.length}>
              {connections.length === 0 && <option>No saved connections</option>}
              {connections.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.dialect}</option>)}
            </select>
            <textarea value={query} onChange={(e) => setQuery(e.target.value)} rows={4} placeholder="SELECT id, status FROM orders WHERE total > 0" className={`${INPUT} font-mono text-[11px]`} />
            <p className="text-[10px] text-gray-400">SELECT / WITH only — writes are rejected.</p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <label className="text-[11px] text-gray-600">min rows
                <input type="number" min={0} value={minRows} onChange={(e) => setMinRows(e.target.value)} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">max rows
                <input type="number" min={0} value={maxRows} onChange={(e) => setMaxRows(e.target.value)} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">column
                <input value={column} onChange={(e) => setColumn(e.target.value)} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">equals
                <input value={equals} onChange={(e) => setEquals(e.target.value)} className={`${INPUT} py-1 mt-0.5`} />
              </label>
            </div>

            <div className="flex items-center justify-end">
              <button type="button" onClick={() => void validate()} disabled={busy || !connectionId || !query.trim()} className={PRIMARY_BTN}>
                {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {busy ? 'Running…' : 'Run'}
              </button>
            </div>
          </div>

          {/* ── Result ── */}
          {result && (
            <div className="space-y-3">
              <div className={`rounded-lg border px-3 py-2 text-[12.5px] font-semibold ${result.passed ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                {result.passed ? 'All checks passed' : 'Checks failed'}
                <span className="ml-2 font-normal text-[11px] text-gray-400 tabular-nums">{result.rowCount} rows · {formatDuration(result.elapsedMs)}</span>
              </div>

              {result.checks.length > 0 && (
                <div className="space-y-1">
                  {result.checks.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11.5px]">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${c.pass ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>{c.pass ? 'pass' : 'fail'}</span>
                      <span className="font-medium text-gray-700">{c.name}</span>
                      <span className="text-gray-400 min-w-0 truncate">{c.detail}</span>
                    </div>
                  ))}
                </div>
              )}

              {previewRows.length > 0 && (
                <div className="border border-[#E9E5FB] rounded-lg overflow-auto">
                  <table className="w-full text-[11.5px]">
                    <thead>
                      <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                        {previewCols.map((col) => <th key={col} className="font-semibold px-2.5 py-1.5 whitespace-nowrap">{col}</th>)}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {previewRows.map((row, i) => (
                        <tr key={i}>
                          {previewCols.map((col) => <td key={col} className="px-2.5 py-1.5 text-gray-700 font-mono whitespace-nowrap">{String((row as Record<string, unknown>)[col])}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
