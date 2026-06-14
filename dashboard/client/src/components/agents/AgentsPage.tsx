import { useEffect, useState } from 'react';
import type { AgentConfig } from '@devteam-dashboard/shared';
import { Plus, Edit2, Trash2, Bot, Target, Wrench, FileOutput, Server, BrainCircuit, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

const API_BASE = import.meta.env.VITE_API_URL || '';

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // form state
  const [isEditing, setIsEditing] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [currentId, setCurrentId] = useState('');
  const [role, setRole] = useState('');
  const [objective, setObjective] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');
  const [runtime, setRuntime] = useState('');
  const [tools, setTools] = useState('');
  const [outputs, setOutputs] = useState('');
  const [instructions, setInstructions] = useState('');

  const fetchAgents = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/agents`);
      if (res.ok) {
        const data = await res.json();
        setAgents(data);
      } else {
        setError('Failed to fetch agents');
      }
    } catch (err) {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAgents();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const toolArray = tools.split(',').map(s => s.trim()).filter(Boolean);
      const outputArray = outputs.split(',').map(s => s.trim()).filter(Boolean);

      const payload = {
        id: currentId,
        role,
        objective,
        model,
        thinking,
        runtime,
        tools: toolArray,
        outputs: outputArray,
        instructions
      };

      const url = isNew ? `${API_BASE}/api/agents` : `${API_BASE}/api/agents/${currentId}`;
      const method = isNew ? 'POST' : 'PUT';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        setIsEditing(false);
        setIsNew(false);
        resetForm();
        fetchAgents();
      } else {
        setError('Failed to save agent');
      }
    } catch (err) {
      setError('Connection error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this agent?')) return;
    try {
      const res = await fetch(`${API_BASE}/api/agents/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchAgents();
      }
    } catch (err) {
      setError('Connection error');
    }
  };

  const resetForm = () => {
    setCurrentId('');
    setRole('');
    setObjective('');
    setModel('');
    setThinking('');
    setRuntime('');
    setTools('');
    setOutputs('');
    setInstructions('');
    setIsEditing(false);
    setIsNew(false);
  };

  const startEdit = (agent: AgentConfig) => {
    setCurrentId(agent.id);
    setRole(agent.role);
    setObjective(agent.objective);
    setModel(agent.model || '');
    setThinking(agent.thinking || '');
    setRuntime(agent.runtime || '');
    setTools(agent.tools.join(', '));
    setOutputs(agent.outputs.join(', '));
    setInstructions(agent.instructions);
    setIsEditing(true);
    setIsNew(false);
  };

  const startNew = () => {
    resetForm();
    setIsEditing(true);
    setIsNew(true);
  };

  return (
    <div className="p-6 mx-auto h-full overflow-y-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Bot className="w-6 h-6 text-primary" />
            Agents Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Configure and manage AI agents for your workflows.</p>
        </div>
        {!isEditing && (
          <button
            onClick={startNew}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm hover:shadow"
          >
            <Plus className="w-4 h-4" />
            Create Agent
          </button>
        )}
      </div>

      {error && <div className="mb-4 p-3 bg-red-500/10 text-red-500 border border-red-500/20 rounded">{error}</div>}

      {isEditing ? (
        <form onSubmit={handleSave} className="bg-card/60 border border-border/50 rounded-xl p-6 space-y-6 mb-8 shadow-sm transition-all animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-center gap-2 border-b border-border/50 pb-4">
            <Bot className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isNew ? 'Create New Agent' : 'Edit Agent Configuration'}</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5 text-foreground/80">
                <TerminalSquare className="w-4 h-4 text-muted-foreground" />
                ID <span className="text-muted-foreground font-normal">(used in workflow steps)</span>
              </label>
              <input
                required
                disabled={!isNew}
                type="text"
                value={currentId}
                onChange={e => setCurrentId(e.target.value)}
                placeholder="e.g. researcher"
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5 text-foreground/80">
                <Target className="w-4 h-4 text-muted-foreground" />
                Role
              </label>
              <input
                required
                type="text"
                value={role}
                onChange={e => setRole(e.target.value)}
                placeholder="e.g. Research Specialist"
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1.5 text-foreground/80">
              <BrainCircuit className="w-4 h-4 text-muted-foreground" />
              Objective
            </label>
            <input
              required
              type="text"
              value={objective}
              onChange={e => setObjective(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              placeholder="What is this agent's main goal?"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground/80">Model <span className="text-muted-foreground font-normal">(optional)</span></label>
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                placeholder="e.g. gpt-4"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground/80">Thinking <span className="text-muted-foreground font-normal">(optional)</span></label>
              <input
                type="text"
                value={thinking}
                onChange={e => setThinking(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5 text-foreground/80">
                <Server className="w-4 h-4 text-muted-foreground" />
                Runtime <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={runtime}
                onChange={e => setRuntime(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5 text-foreground/80">
                <Wrench className="w-4 h-4 text-muted-foreground" />
                Tools <span className="text-muted-foreground font-normal">(comma separated)</span>
              </label>
              <input
                type="text"
                value={tools}
                onChange={e => setTools(e.target.value)}
                placeholder="read, write, exec"
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5 text-foreground/80">
                <FileOutput className="w-4 h-4 text-muted-foreground" />
                Outputs <span className="text-muted-foreground font-normal">(comma separated)</span>
              </label>
              <input
                type="text"
                value={outputs}
                onChange={e => setOutputs(e.target.value)}
                placeholder="output/research.md"
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground/80">Instructions Prompt</label>
            <textarea
              required
              rows={8}
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              placeholder="System instructions for the agent..."
            />
          </div>

          <div className="flex gap-3 justify-end pt-4 border-t border-border/50">
            <button type="button" onClick={resetForm} className="px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted rounded-lg transition-colors">
              Cancel
            </button>
            <button type="submit" className="px-5 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm">
              Save Agent
            </button>
          </div>
        </form>
      ) : null}

      {loading && !isEditing ? (
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {agents.map(agent => (
            <div
              key={agent.id}
              className={cn(
                "group relative bg-card/60 border border-border/50 rounded-xl p-5 transition-all duration-200",
                "hover:border-border hover:bg-card hover:shadow-md hover:glow-sm flex flex-col h-full"
              )}
            >
              <div className="flex justify-between items-start mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20 shrink-0">
                    <Bot className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground text-lg leading-tight">{agent.id}</h3>
                    <span className="text-xs font-medium px-2 py-0.5 bg-blue-500/10 text-blue-500 border border-blue-500/20 rounded-full inline-block mt-1">
                      {agent.role}
                    </span>
                  </div>
                </div>

                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => startEdit(agent)}
                    className="p-1.5 text-muted-foreground hover:text-blue-400 hover:bg-blue-500/10 rounded-md transition-colors"
                    title="Edit agent"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(agent.id)}
                    className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                    title="Delete agent"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <p className="text-sm text-muted-foreground mb-4 flex-1 line-clamp-2" title={agent.objective}>
                {agent.objective}
              </p>

              <div className="flex flex-wrap gap-2 text-[11px] mt-auto pt-4 border-t border-border/40">
                {agent.model && (
                  <span className="flex items-center gap-1 text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50">
                    <BrainCircuit className="w-3 h-3" />
                    {agent.model}
                  </span>
                )}
                {agent.tools.length > 0 && (
                  <span className="flex items-center gap-1 text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50" title={agent.tools.join(', ')}>
                    <Wrench className="w-3 h-3" />
                    {agent.tools.length} tool{agent.tools.length !== 1 ? 's' : ''}
                  </span>
                )}
                {agent.outputs.length > 0 && (
                  <span className="flex items-center gap-1 text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50" title={agent.outputs.join(', ')}>
                    <FileOutput className="w-3 h-3" />
                    {agent.outputs.length} output{agent.outputs.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && agents.length === 0 && !isEditing && (
        <div className="text-center py-16 border-2 border-dashed border-border/60 rounded-xl bg-card/30">
          <Bot className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-foreground mb-1">No Agents Found</h3>
          <p className="text-muted-foreground mb-4">Create your first agent to get started.</p>
          <button
            onClick={startNew}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Create Agent
          </button>
        </div>
      )}
    </div>
  );
}
