import { useEffect, useState } from 'react';
import type { AgentConfig } from '@devteam-dashboard/shared';

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
    <div className="p-6 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">Agents Settings</h1>
        {!isEditing && (
          <button
            onClick={startNew}
            className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-semibold hover:bg-blue-600 transition-colors"
          >
            Create Agent
          </button>
        )}
      </div>

      {error && <div className="mb-4 p-3 bg-red-500/10 text-red-500 border border-red-500/20 rounded">{error}</div>}

      {isEditing ? (
        <form onSubmit={handleSave} className="bg-card border border-border rounded-lg p-5 space-y-4 mb-6">
          <h2 className="text-lg font-semibold">{isNew ? 'New Agent' : 'Edit Agent'}</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">ID (used in workflow steps)</label>
              <input
                required
                disabled={!isNew}
                type="text"
                value={currentId}
                onChange={e => setCurrentId(e.target.value)}
                placeholder="e.g. researcher"
                className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Role</label>
              <input
                required
                type="text"
                value={role}
                onChange={e => setRole(e.target.value)}
                placeholder="e.g. Research Specialist"
                className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Objective</label>
            <input
              required
              type="text"
              value={objective}
              onChange={e => setObjective(e.target.value)}
              className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Model (optional)</label>
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Thinking (optional)</label>
              <input
                type="text"
                value={thinking}
                onChange={e => setThinking(e.target.value)}
                className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Runtime (optional)</label>
              <input
                type="text"
                value={runtime}
                onChange={e => setRuntime(e.target.value)}
                className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Tools (comma separated)</label>
              <input
                type="text"
                value={tools}
                onChange={e => setTools(e.target.value)}
                placeholder="read, write, exec"
                className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Outputs (comma separated)</label>
              <input
                type="text"
                value={outputs}
                onChange={e => setOutputs(e.target.value)}
                placeholder="output/research.md"
                className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Instructions Prompt</label>
            <textarea
              required
              rows={8}
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm font-mono"
            />
          </div>

          <div className="flex gap-2 justify-end pt-2 border-t border-border">
            <button type="button" onClick={resetForm} className="px-4 py-2 text-sm text-muted-foreground hover:bg-accent rounded-md transition-colors">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-semibold hover:bg-blue-600 transition-colors">
              Save Agent
            </button>
          </div>
        </form>
      ) : null}

      {loading && !isEditing ? (
        <p className="text-muted-foreground">Loading agents...</p>
      ) : (
        <div className="space-y-4">
          {agents.map(agent => (
            <div key={agent.id} className="bg-card border border-border rounded-lg p-4 flex justify-between items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-lg">{agent.id}</h3>
                  <span className="text-xs px-2 py-0.5 bg-blue-500/10 text-blue-500 rounded-full">{agent.role}</span>
                </div>
                <p className="text-sm text-muted-foreground mb-2">{agent.objective}</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  {agent.model && <span className="text-muted-foreground bg-muted px-2 py-1 rounded">Model: {agent.model}</span>}
                  {agent.tools.length > 0 && <span className="text-muted-foreground bg-muted px-2 py-1 rounded">Tools: {agent.tools.join(', ')}</span>}
                  {agent.outputs.length > 0 && <span className="text-muted-foreground bg-muted px-2 py-1 rounded">Outputs: {agent.outputs.join(', ')}</span>}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => startEdit(agent)} className="text-sm px-3 py-1 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded transition-colors">Edit</button>
                <button onClick={() => handleDelete(agent.id)} className="text-sm px-3 py-1 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded transition-colors">Delete</button>
              </div>
            </div>
          ))}
          {agents.length === 0 && !isEditing && (
            <p className="text-center text-muted-foreground py-8 border border-dashed border-border rounded-lg">
              No agents found. Create one to get started!
            </p>
          )}
        </div>
      )}
    </div>
  );
}
