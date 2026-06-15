import { useEffect, useState } from 'react';
import type { CustomWorkflow, AgentConfig } from '@devteam-dashboard/shared';
import { Plus, Edit2, Trash2, GitMerge, FileText, ListTree, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

const API_BASE = import.meta.env.VITE_API_URL || '';

export function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<CustomWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentConfig[]>([]);

  // form state
  const [isEditing, setIsEditing] = useState(false);
  const [currentId, setCurrentId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');

  const fetchWorkflows = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/agents`);
      if (res.ok) {
        const data = await res.json();
        setAgents(data);
      }
    } catch {}

    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/workflows`);
      if (res.ok) {
        const data = await res.json();
        setWorkflows(data);
      } else {
        setError('Failed to fetch workflows');
      }
    } catch (err) {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWorkflows();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const stepArray = steps.split(',').map(s => s.trim()).filter(Boolean);

      const payload = {
        id: currentId || `wf_${Date.now()}`,
        name,
        description,
        steps: stepArray
      };

      const url = currentId ? `${API_BASE}/api/workflows/${currentId}` : `${API_BASE}/api/workflows`;
      const method = currentId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        setIsEditing(false);
        resetForm();
        fetchWorkflows();
      } else {
        setError('Failed to save workflow');
      }
    } catch (err) {
      setError('Connection error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this workflow?')) return;
    try {
      const res = await fetch(`${API_BASE}/api/workflows/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchWorkflows();
      }
    } catch (err) {
      setError('Connection error');
    }
  };

  const resetForm = () => {
    setCurrentId('');
    setName('');
    setDescription('');
    setSteps('');
    setIsEditing(false);
  };

  const startEdit = (wf: CustomWorkflow) => {
    setCurrentId(wf.id);
    setName(wf.name);
    setDescription(wf.description);
    setSteps(wf.steps.join(', '));
    setIsEditing(true);
  };

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <GitMerge className="w-6 h-6 text-primary" />
            Custom Workflows
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Design and manage agent execution sequences.</p>
        </div>
        {!isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm hover:shadow"
          >
            <Plus className="w-4 h-4" />
            Create Workflow
          </button>
        )}
      </div>

      {error && <div className="mb-4 p-3 bg-red-500/10 text-red-500 border border-red-500/20 rounded-lg">{error}</div>}

      {isEditing ? (
        <form onSubmit={handleSave} className="bg-card/60 border border-border/50 rounded-xl p-6 space-y-6 mb-8 shadow-sm transition-all animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-center gap-2 border-b border-border/50 pb-4">
            <GitMerge className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{currentId ? 'Edit Workflow' : 'Create New Workflow'}</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5 text-foreground/80">
                <FileText className="w-4 h-4 text-muted-foreground" />
                Name
              </label>
              <input
                required
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                placeholder="e.g. Code Review Process"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5 text-foreground/80">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                placeholder="Brief description of this workflow"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1.5 text-foreground/80">
              <ListTree className="w-4 h-4 text-muted-foreground" />
              Steps <span className="text-muted-foreground font-normal">(comma separated agent IDs)</span>
            </label>
            <input
              required
              type="text"
              value={steps}
              onChange={e => setSteps(e.target.value)}
              placeholder="clarifier, planner, implementer, verifier"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-mono"
            />
            {agents.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                <span className="text-xs text-muted-foreground mr-1">Available agents:</span>
                {agents.map(a => (
                  <span key={a.id} className="text-[10px] px-1.5 py-0.5 bg-muted rounded border border-border text-muted-foreground">
                    {a.id}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-3 justify-end pt-4 border-t border-border/50">
            <button type="button" onClick={resetForm} className="px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted rounded-lg transition-colors">
              Cancel
            </button>
            <button type="submit" className="px-5 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm">
              Save Workflow
            </button>
          </div>
        </form>
      ) : null}

      {loading && !isEditing ? (
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {workflows.map(wf => (
            <div
              key={wf.id}
              className={cn(
                "group relative bg-card/60 border border-border/50 rounded-xl p-5 transition-all duration-200",
                "hover:border-border hover:bg-card hover:shadow-md hover:glow-sm flex flex-col md:flex-row md:items-center justify-between gap-4"
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20 shrink-0">
                    <GitMerge className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground text-lg">{wf.name}</h3>
                    {wf.description && <p className="text-sm text-muted-foreground">{wf.description}</p>}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-1 md:pl-13">
                  {wf.steps.map((step, index) => (
                    <div key={index} className="flex items-center">
                      <span className="text-xs font-medium px-2 py-1 bg-blue-500/10 text-blue-500 border border-blue-500/20 rounded-md">
                        {step}
                      </span>
                      {index < wf.steps.length - 1 && (
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 mx-0.5" />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 shrink-0 md:self-start opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => startEdit(wf)}
                  className="p-2 text-muted-foreground hover:text-blue-400 hover:bg-blue-500/10 rounded-md transition-colors"
                  title="Edit workflow"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(wf.id)}
                  className="p-2 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                  title="Delete workflow"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}

          {workflows.length === 0 && !isEditing && (
            <div className="text-center py-16 border-2 border-dashed border-border/60 rounded-xl bg-card/30">
              <GitMerge className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-foreground mb-1">No Workflows Found</h3>
              <p className="text-muted-foreground mb-4">Create your first custom workflow to orchestrate agents.</p>
              <button
                onClick={() => setIsEditing(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm"
              >
                <Plus className="w-4 h-4" />
                Create Workflow
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
