import { useState, useEffect } from 'react';
import { Database, FileText, ArrowRightLeft, ShieldCheck, Loader2, HardDrive, Globe, Cpu } from 'lucide-react';
import { getTestData } from '../../services/api';
import type { TestDataset, TestFieldData, TestDataMapping, DataValidationExpectation } from '../../types';

interface TestDataTabProps {
  runId: string;
}

export default function TestDataTab({ runId }: TestDataTabProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<TestDataset[]>([]);
  const [fieldData, setFieldData] = useState<TestFieldData[]>([]);
  const [mappings, setMappings] = useState<TestDataMapping[]>([]);
  const [validations, setValidations] = useState<DataValidationExpectation[]>([]);
  const [activeSection, setActiveSection] = useState<'datasets' | 'fields' | 'mappings' | 'validations'>('datasets');
  const [expandedDataset, setExpandedDataset] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    getTestData(runId)
      .then((data) => {
        if (!mounted) return;
        setDatasets(data.datasets || []);
        setFieldData(data.fieldData || []);
        setMappings(data.mappings || []);
        setValidations(data.validations || []);
        setError(null);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err?.response?.status === 404 ? 'No test data found for this run.' : 'Failed to load test data.');
      })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [runId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading test data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <Database className="w-10 h-10 mb-3 opacity-40" />
        <p>{error}</p>
        <p className="text-sm mt-1">Test data is generated when you run the test generation pipeline.</p>
      </div>
    );
  }

  const sections = [
    { key: 'datasets' as const, label: 'Datasets', icon: Database, count: datasets.length },
    { key: 'fields' as const, label: 'Field Data', icon: FileText, count: fieldData.length },
    { key: 'mappings' as const, label: 'Mappings', icon: ArrowRightLeft, count: mappings.length },
    { key: 'validations' as const, label: 'Validations', icon: ShieldCheck, count: validations.length },
  ];

  return (
    <div className="space-y-4">
      {/* Section toggle */}
      <div className="flex gap-2 border-b border-gray-700 pb-2">
        {sections.map(({ key, label, icon: Icon, count }) => (
          <button
            key={key}
            onClick={() => setActiveSection(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-t transition-colors ${
              activeSection === key
                ? 'bg-gray-700 text-white border-b-2 border-blue-500'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            <span className="ml-1 text-xs bg-gray-600 px-1.5 py-0.5 rounded-full">{count}</span>
          </button>
        ))}
      </div>

      {/* Datasets section */}
      {activeSection === 'datasets' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-700">
                <th className="pb-2 pr-4">Dataset ID</th>
                <th className="pb-2 pr-4">Role</th>
                <th className="pb-2 pr-4">Scenario</th>
                <th className="pb-2 pr-4">Source</th>
                <th className="pb-2 pr-4">Layer</th>
                <th className="pb-2">Fields</th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((ds) => (
                <tr key={ds.dataset_id} className="border-b border-gray-800 hover:bg-gray-800/50">
                  <td className="py-2 pr-4 font-mono text-blue-400">{ds.dataset_id}</td>
                  <td className="py-2 pr-4">
                    <span className="px-2 py-0.5 bg-blue-900/40 text-blue-300 rounded text-xs">{ds.role}</span>
                  </td>
                  <td className="py-2 pr-4 text-gray-300">{ds.scenario}</td>
                  <td className="py-2 pr-4">
                    <SourceBadge source={ds.source || 'static'} />
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      ds.layer === 'ui' ? 'bg-green-900/40 text-green-300' :
                      ds.layer === 'api' ? 'bg-orange-900/40 text-orange-300' :
                      'bg-blue-900/40 text-blue-300'
                    }`}>{ds.layer}</span>
                  </td>
                  <td className="py-2">
                    <button
                      onClick={() => setExpandedDataset(expandedDataset === ds.dataset_id ? null : ds.dataset_id)}
                      className="text-xs text-blue-400 hover:text-blue-300 underline"
                    >
                      {expandedDataset === ds.dataset_id ? 'Hide' : `${Object.keys(ds.fields || {}).length} fields`}
                    </button>
                    {expandedDataset === ds.dataset_id && (
                      <div className="mt-2 space-y-2">
                        <div className="p-2 bg-gray-900 rounded text-xs font-mono">
                          {Object.entries(ds.fields || {}).map(([k, v]) => (
                            <div key={k} className="flex gap-2">
                              <span className="text-gray-400">{k}:</span>
                              <span className={v.startsWith('{{db:') ? 'text-amber-300' : 'text-green-300'}>{v}</span>
                            </div>
                          ))}
                        </div>
                        {ds.source_config && (
                          <div className="p-2 bg-gray-900 border border-amber-800/40 rounded text-xs">
                            <div className="text-amber-400 font-semibold mb-1 flex items-center gap-1">
                              <HardDrive className="w-3 h-3" /> Database Source
                            </div>
                            {ds.source_config.db_table && (
                              <div className="flex gap-2"><span className="text-gray-400">Table:</span><span className="text-amber-300 font-mono">{ds.source_config.db_table}</span></div>
                            )}
                            {ds.source_config.db_query && (
                              <div className="mt-1">
                                <span className="text-gray-400">Query:</span>
                                <pre className="mt-0.5 p-1.5 bg-gray-950 rounded text-amber-200 font-mono overflow-x-auto">{ds.source_config.db_query}</pre>
                              </div>
                            )}
                            {ds.source_config.description && (
                              <div className="mt-1 text-gray-400 italic">{ds.source_config.description}</div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {datasets.length === 0 && (
                <tr><td colSpan={6} className="py-8 text-center text-gray-500">No datasets generated</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Field Data section */}
      {activeSection === 'fields' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-700">
                <th className="pb-2 pr-4">ID</th>
                <th className="pb-2 pr-4">Field</th>
                <th className="pb-2 pr-4">Value</th>
                <th className="pb-2 pr-4">Type</th>
                <th className="pb-2 pr-4">Source</th>
                <th className="pb-2 pr-4">Data Type</th>
                <th className="pb-2">Validation Rule</th>
              </tr>
            </thead>
            <tbody>
              {fieldData.map((fd) => (
                <tr key={fd.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                  <td className="py-2 pr-4 font-mono text-xs text-gray-500">{fd.id}</td>
                  <td className="py-2 pr-4 font-medium text-gray-200">{fd.field_name}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-gray-300">
                    <span className={fd.value?.startsWith('{{db:') ? 'text-amber-300' : ''}>{fd.value}</span>
                    {fd.source_detail && (
                      <div className="text-[10px] text-amber-400/70 mt-0.5">{fd.source_detail}</div>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      fd.type === 'valid' ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'
                    }`}>{fd.type}</span>
                  </td>
                  <td className="py-2 pr-4">
                    <SourceBadge source={fd.source || 'static'} />
                  </td>
                  <td className="py-2 pr-4 text-xs text-gray-400">{fd.data_type}</td>
                  <td className="py-2 text-xs text-gray-400">{fd.validation_rule || '-'}</td>
                </tr>
              ))}
              {fieldData.length === 0 && (
                <tr><td colSpan={7} className="py-8 text-center text-gray-500">No field data generated</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Mappings section */}
      {activeSection === 'mappings' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-700">
                <th className="pb-2 pr-4">Test Case ID</th>
                <th className="pb-2 pr-4">Dataset ID</th>
                <th className="pb-2">Dataset Role</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m, i) => {
                const ds = datasets.find(d => d.dataset_id === m.dataset_id);
                return (
                  <tr key={i} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="py-2 pr-4 font-mono text-blue-400">{m.test_case_id}</td>
                    <td className="py-2 pr-4 font-mono text-green-400">{m.dataset_id}</td>
                    <td className="py-2">
                      {ds ? (
                        <span className="px-2 py-0.5 bg-blue-900/40 text-blue-300 rounded text-xs">
                          {ds.role} / {ds.scenario}
                        </span>
                      ) : '-'}
                    </td>
                  </tr>
                );
              })}
              {mappings.length === 0 && (
                <tr><td colSpan={3} className="py-8 text-center text-gray-500">No mappings generated</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Validations section */}
      {activeSection === 'validations' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-700">
                <th className="pb-2 pr-4">Field</th>
                <th className="pb-2 pr-4">Value</th>
                <th className="pb-2 pr-4">Validation</th>
                <th className="pb-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {validations.map((v, i) => (
                <tr key={i} className="border-b border-gray-800 hover:bg-gray-800/50">
                  <td className="py-2 pr-4 font-medium text-gray-200">{v.field}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-gray-300">{v.value}</td>
                  <td className="py-2 pr-4">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      v.validation === 'accepted' ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'
                    }`}>{v.validation}</span>
                  </td>
                  <td className="py-2 text-xs text-gray-400">{v.reason}</td>
                </tr>
              ))}
              {validations.length === 0 && (
                <tr><td colSpan={4} className="py-8 text-center text-gray-500">No validation expectations generated</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SourceBadge({ source }: { source: string }) {
  const config: Record<string, { icon: typeof Database; label: string; className: string }> = {
    static: { icon: FileText, label: 'Static', className: 'bg-gray-700 text-gray-300' },
    database: { icon: HardDrive, label: 'Database', className: 'bg-amber-900/40 text-amber-300' },
    api: { icon: Globe, label: 'API', className: 'bg-cyan-900/40 text-cyan-300' },
    computed: { icon: Cpu, label: 'Computed', className: 'bg-blue-900/40 text-blue-300' },
    mixed: { icon: Database, label: 'Mixed', className: 'bg-blue-900/40 text-blue-300' },
  };
  const c = config[source] || config.static;
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${c.className}`}>
      <Icon className="w-3 h-3" />{c.label}
    </span>
  );
}
