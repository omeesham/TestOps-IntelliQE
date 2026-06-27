import { useState, useEffect } from 'react';
import { FileSearch, Map, Code, Heart, ShieldCheck, Wrench, Loader2 } from 'lucide-react';
import { getAgentStatus, getAgentQueue, type AgentQueueItem } from '@/services/api';
import type { AgentInfo } from '@/types';

const iconMap: Record<string, React.ElementType> = { FileSearch, Map, Code, Heart, ShieldCheck, Wrench };

const statusColors: Record<string, string> = {
  idle: 'bg-[#DEEAFF] text-[#6B7280] border-[#C9DCFF]',
  active: 'bg-[#155dfc]/10 text-[#155dfc] border-[#155dfc]/20',
  running: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  error: 'bg-red-50 text-red-600 border-red-200',
  completed: 'bg-emerald-50 text-emerald-600 border-emerald-200',
};

const stageColors: Record<string, string> = {
  pending_requirements: 'bg-[#DEEAFF] text-[#6B7280]',
  requirements: 'bg-[#155dfc]/10 text-[#155dfc]',
  pending_planning: 'bg-amber-50 text-amber-600',
  planning: 'bg-[#155dfc]/10 text-[#155dfc]',
  pending_generation: 'bg-orange-50 text-orange-600',
  generation: 'bg-[#155dfc]/10 text-[#155dfc]',
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
    <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#C9DCFF]/60 p-5 hover:shadow-lg hover:shadow-blue-500/5 transition-all group">
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110 ${isActive ? 'bg-gradient-to-br from-[#155dfc]/10 to-[#06B6D4]/10 text-[#155dfc]' : 'bg-[#DEEAFF] text-[#93B4FB]'}`}>
          <Icon className="w-5 h-5" />
        </div>
        <span className={`text-[10px] px-2.5 py-1 rounded-full font-semibold uppercase tracking-wide border ${statusColors[agent.status] || statusColors.idle}`}>
          {agent.status}
        </span>
      </div>
      <h4 className="font-semibold text-[#1E1B4B] text-sm mb-1">{agent.name}</h4>
      <p className="text-xs text-[#6B7280] mb-2 line-clamp-2">{agent.description}</p>
      <div className="text-[10px] text-[#155dfc] bg-[#155dfc]/5 px-2 py-1 rounded-lg mb-3 font-mono border border-[#155dfc]/10">{agent.model}</div>
      <div className="flex items-center justify-between text-xs text-[#6B7280] border-t border-[#DEEAFF] pt-3">
        <span>Queue: <strong className="text-[#1E1B4B]">{agent.queueSize}</strong></span>
        <span>Avg: <strong className="text-[#1E1B4B]">{agent.processingTime}</strong></span>
      </div>
      {agent.handoffTo && (
        <p className="text-[10px] text-[#6B7280] mt-2">Handoff → <span className="text-[#155dfc] font-medium">{agent.handoffTo}</span></p>
      )}
      {agent.lastRun && <p className="text-xs text-[#93B4FB] mt-1">Last: {agent.lastRun}</p>}
    </div>
  );
}

export default function AgentMonitorPage() {
  const [agentsData, setAgentsData] = useState<AgentInfo[]>([]);
  const [queue, setQueue] = useState<AgentQueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getAgentStatus()
        .then((data) => setAgentsData(data.agents || []))
        .catch(console.error),
      getAgentQueue()
        .then((data) => setQueue(Array.isArray(data.queue) ? data.queue : []))
        .catch(console.error),
    ]).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-[#155dfc] animate-spin" />
        <span className="ml-3 text-sm text-[#6B7280]">Loading agents...</span>
      </div>
    );
  }

  const sortedAgents = [...agentsData].sort((a, b) => a.pipelineOrder - b.pipelineOrder);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <button className="px-4 py-2.5 bg-[#155dfc] text-white rounded-lg text-sm font-medium hover:bg-[#124fd6] shadow-md shadow-blue-500/20 transition-all">
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
      <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#C9DCFF]/60 p-5">
        <h3 className="text-sm font-semibold text-[#1E1B4B] mb-4">Agent Pipeline Flow</h3>
        <div className="flex items-center justify-between overflow-x-auto pb-2">
          {sortedAgents.map((agent, i) => {
            const isActive = agent.status === 'running' || agent.status === 'active';
            return (
              <div key={agent.id} className="flex items-center">
                <div className={`flex flex-col items-center px-3 ${isActive ? 'opacity-100' : 'opacity-50'}`}>
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold ${isActive ? 'bg-gradient-to-br from-[#155dfc] to-[#155dfc] text-white shadow-md shadow-blue-500/30' : 'bg-[#DEEAFF] text-[#93B4FB]'}`}>
                    {agent.pipelineOrder}
                  </div>
                  <span className="text-[10px] text-[#6B7280] mt-1 whitespace-nowrap max-w-[80px] text-center font-medium">{agent.name}</span>
                  <span className="text-[10px] text-[#155dfc] mt-0.5">{agent.agentFile.replace('.agent.md', '')}</span>
                </div>
                {i < sortedAgents.length - 1 && (
                  <div className={`w-10 h-px flex-shrink-0 ${isActive ? 'bg-gradient-to-r from-[#155dfc] to-[#06B6D4]' : 'bg-[#C9DCFF]'}`} />
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-3 p-3 bg-[#EFF5FF] rounded-lg border border-[#C9DCFF]/50">
          <p className="text-xs text-[#6B7280]">
            <strong className="text-[#1E1B4B]">Conditional:</strong> Healer triggers <code className="bg-white px-1.5 py-0.5 rounded text-[10px] text-[#155dfc] border border-[#C9DCFF]/50">on-generation-fail</code> ·
            Audit triggers <code className="bg-white px-1.5 py-0.5 rounded text-[10px] text-[#155dfc] border border-[#C9DCFF]/50">on-generation-pass</code> ·
            Maintainer is <code className="bg-white px-1.5 py-0.5 rounded text-[10px] text-[#06B6D4] border border-[#C9DCFF]/50">on-demand</code>
          </p>
        </div>
      </div>

      {/* Queue — real pipeline runs from /agents/queue */}
      <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#C9DCFF]/60 overflow-hidden">
        <div className="p-4 border-b border-[#C9DCFF]/60 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#1E1B4B]">Pipeline Run Queue</h3>
          <span className="text-xs text-[#93B4FB] bg-[#155dfc]/5 px-2 py-1 rounded-full">{queue.length} items</span>
        </div>
        {queue.length === 0 ? (
          <div className="py-10 px-4 text-center text-sm text-[#6B7280]">
            No pipeline runs in the queue right now.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#EFF5FF]">
                  <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">ID</th>
                  <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Feature</th>
                  <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Module</th>
                  <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Stage</th>
                  <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Priority</th>
                  <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Status</th>
                  <th className="text-left py-3 px-4 font-medium text-[#6B7280] text-xs uppercase tracking-wide">Cost</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q) => (
                  <tr key={q.id} className="border-t border-[#DEEAFF] hover:bg-[#EFF5FF]/50 transition-colors">
                    <td className="py-3 px-4 font-mono text-xs text-[#6B7280]">{q.id.slice(0, 8)}</td>
                    <td className="py-3 px-4 font-medium text-[#1E1B4B]">{q.feature || '—'}</td>
                    <td className="py-3 px-4">{q.module ? <span className="px-2 py-0.5 bg-[#DEEAFF] text-[#155dfc] rounded text-xs font-medium">{q.module}</span> : <span className="text-[#93B4FB] text-xs">—</span>}</td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${stageColors[q.stage] || 'bg-[#DEEAFF]'}`}>
                        {q.stage ? q.stage.replace(/_/g, ' ') : '—'}
                      </span>
                    </td>
                    <td className="py-3 px-4"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${q.priority === 'P0' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>{q.priority || 'P1'}</span></td>
                    <td className="py-3 px-4"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[q.status] || statusColors.idle}`}>{q.status || 'idle'}</span></td>
                    <td className="py-3 px-4 text-xs text-[#6B7280]">{typeof q.cost === 'number' ? `$${q.cost.toFixed(4)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
