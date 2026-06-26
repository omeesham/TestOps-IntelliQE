import { useState, useEffect } from 'react';
import { FileSearch, Map, Code, Heart, ShieldCheck, Wrench, Loader2, Cpu } from 'lucide-react';
import { mockQueue } from '@/data/mockData';
import { getAgentStatus } from '@/services/api';
import type { AgentInfo } from '@/types';

const iconMap: Record<string, React.ElementType> = { FileSearch, Map, Code, Heart, ShieldCheck, Wrench };

const statusColors: Record<string, string> = {
  idle: 'bg-[#DCE7FF] text-[#6B7280] border-[#C5D6FF]',
  active: 'bg-[#3366FF]/10 text-[#2143A8] border-[#3366FF]/20',
  running: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  error: 'bg-red-50 text-red-600 border-red-200',
  completed: 'bg-emerald-50 text-emerald-600 border-emerald-200',
};

const stageColors: Record<string, string> = {
  pending_requirements: 'bg-[#DCE7FF] text-[#6B7280]',
  requirements: 'bg-[#3366FF]/10 text-[#2143A8]',
  pending_planning: 'bg-amber-50 text-amber-600',
  planning: 'bg-[#2645D6]/10 text-[#2645D6]',
  pending_generation: 'bg-orange-50 text-orange-600',
  generation: 'bg-[#3366FF]/10 text-[#2143A8]',
  testing: 'bg-[#06B6D4]/10 text-[#06B6D4]',
  pending_healing: 'bg-amber-50 text-amber-600',
  healing: 'bg-rose-50 text-rose-600',
  completed: 'bg-emerald-50 text-emerald-600',
  fixme: 'bg-red-50 text-red-600',
};

function AgentCard({ agent }: { agent: AgentInfo }) {
  const Icon = iconMap[agent.icon] || Code;
  const isActive = agent.status === 'running' || agent.status === 'active';
  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-[#DCE7FF] shadow-sm p-5 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-violet-500/10 transition-all duration-200 group">
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110 ${isActive ? 'bg-gradient-to-br from-[#3366FF]/10 to-[#06B6D4]/10 text-[#2143A8]' : 'bg-[#DCE7FF] text-[#6B7280]'}`}>
          <Icon className="w-5 h-5" />
        </div>
        <span className={`text-[10px] px-2.5 py-1 rounded-full font-semibold uppercase tracking-wide border ${statusColors[agent.status]}`}>
          {agent.status}
        </span>
      </div>
      <h4 className="font-semibold text-[#1E3A8A] text-sm mb-1">{agent.name}</h4>
      <p className="text-xs text-[#6B7280] mb-2 line-clamp-2">{agent.description}</p>
      <div className="text-[10px] text-[#2143A8] bg-[#3366FF]/5 px-2 py-1 rounded-lg mb-3 font-mono border border-[#3366FF]/10">{agent.model}</div>
      <div className="flex items-center justify-between text-xs text-[#6B7280] border-t border-[#DCE7FF] pt-3">
        <span>Queue: <strong className="text-[#1E3A8A]">{agent.queueSize}</strong></span>
        <span>Avg: <strong className="text-[#1E3A8A]">{agent.processingTime}</strong></span>
      </div>
      {agent.handoffTo && (
        <p className="text-[10px] text-[#6B7280] mt-2">Handoff → <span className="text-[#2143A8] font-medium">{agent.handoffTo}</span></p>
      )}
      {agent.lastRun && <p className="text-xs text-[#6B7280] mt-1">Last: {agent.lastRun}</p>}
    </div>
  );
}

export default function AgentMonitorPage() {
  const [agentsData, setAgentsData] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAgentStatus()
      .then((data) => setAgentsData(data.agents || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-[#2143A8] animate-spin" />
        <span className="ml-3 text-sm text-[#6B7280]">Loading agents...</span>
      </div>
    );
  }

  const active = agentsData.filter((a) => a.status === 'active' || a.status === 'running').length;
  const sortedAgents = [...agentsData].sort((a, b) => a.pipelineOrder - b.pipelineOrder);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#3366FF] to-[#2645D6] flex items-center justify-center shadow-md shadow-violet-500/25">
            <Cpu className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-[#1E3A8A]">Agent Monitor</h1>
            <p className="text-sm text-[#6B7280]">Live AI agent activity</p>
          </div>
        </div>
        <button className="px-4 py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-medium rounded-lg shadow-md shadow-violet-200 text-sm transition-all">
          Restart All Agents
        </button>
      </div>

      {/* Agent Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sortedAgents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>

      {/* Pipeline Flow */}
      <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-[#DCE7FF] shadow-sm p-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-700 mb-1">Orchestration</p>
        <h3 className="text-sm font-semibold text-[#1E3A8A] mb-4">Agent Pipeline Flow</h3>
        <div className="flex items-center justify-between overflow-x-auto pb-2">
          {sortedAgents.map((agent, i) => {
            const isActive = agent.status === 'running' || agent.status === 'active';
            return (
              <div key={agent.id} className="flex items-center">
                <div className={`flex flex-col items-center px-3 ${isActive ? 'opacity-100' : 'opacity-50'}`}>
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold ${isActive ? 'bg-gradient-to-br from-[#3366FF] to-[#2645D6] text-white shadow-md shadow-purple-500/30' : 'bg-[#DCE7FF] text-[#6B7280]'}`}>
                    {agent.pipelineOrder}
                  </div>
                  <span className="text-[10px] text-[#6B7280] mt-1 whitespace-nowrap max-w-[80px] text-center font-medium">{agent.name}</span>
                  <span className="text-[10px] text-[#2143A8] mt-0.5">{agent.agentFile.replace('.agent.md', '')}</span>
                </div>
                {i < sortedAgents.length - 1 && (
                  <div className={`w-10 h-px flex-shrink-0 ${isActive ? 'bg-gradient-to-r from-[#3366FF] to-[#06B6D4]' : 'bg-[#C5D6FF]'}`} />
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-3 p-3 bg-[#EEF4FF] rounded-xl border border-[#C5D6FF]">
          <p className="text-xs text-[#6B7280]">
            <strong className="text-[#1E3A8A]">Conditional:</strong> Healer triggers <code className="bg-white px-1.5 py-0.5 rounded text-[10px] text-[#2143A8] border border-[#C5D6FF]/50">on-generation-fail</code> ·
            Audit triggers <code className="bg-white px-1.5 py-0.5 rounded text-[10px] text-[#2645D6] border border-[#C5D6FF]/50">on-generation-pass</code> ·
            Maintainer is <code className="bg-white px-1.5 py-0.5 rounded text-[10px] text-[#06B6D4] border border-[#C5D6FF]/50">on-demand</code>
          </p>
        </div>
      </div>

      {/* Queue */}
      <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-[#DCE7FF] shadow-sm overflow-hidden">
        <div className="p-4 border-b border-[#DCE7FF] flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#1E3A8A]">Agent Queue (agent-queue.json)</h3>
          <span className="text-xs text-[#6B7280] bg-[#3366FF]/5 px-2 py-1 rounded-full">{mockQueue.length} items</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#EEF4FF]">
                <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">ID</th>
                <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Feature</th>
                <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Module</th>
                <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Stage</th>
                <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Priority</th>
                <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Locked By</th>
                <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Tests</th>
                <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Steps</th>
              </tr>
            </thead>
            <tbody>
              {mockQueue.map((q) => (
                <tr key={q.id} className="border-t border-[#DCE7FF] hover:bg-[#EEF4FF]/50 transition-colors">
                  <td className="py-3 px-4 font-mono text-xs text-[#6B7280]">{q.id}</td>
                  <td className="py-3 px-4 font-medium text-[#1E3A8A]">{q.feature}</td>
                  <td className="py-3 px-4"><span className="px-2 py-0.5 bg-[#DCE7FF] text-[#2645D6] rounded text-xs font-medium">{q.module}</span></td>
                  <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${stageColors[q.stage] || 'bg-[#DCE7FF]'}`}>
                      {q.stage.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="py-3 px-4"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${q.priority === 'P0' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>{q.priority}</span></td>
                  <td className="py-3 px-4 text-xs">{q.lockedBy ? <span className="text-[#2143A8] font-medium">{q.lockedBy}</span> : <span className="text-[#6B7280]">—</span>}</td>
                  <td className="py-3 px-4 text-xs text-[#6B7280]">{q.totalTcCount > 0 ? `${q.automatableCount}/${q.totalTcCount}` : '—'}</td>
                  <td className="py-3 px-4 text-xs text-[#6B7280]">{q.history.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
