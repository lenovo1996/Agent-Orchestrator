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
    <div className="p-8 h-full overflow-y-auto bg-background/50">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-10 gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-3 tracking-tight">
            <div className="p-2 bg-primary/10 rounded-xl">
              <GitMerge className="w-7 h-7 text-primary" />
            </div>
            Custom Workflows
          </h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-xl leading-relaxed">
            Design and manage agent execution sequences. Define custom workflows to orchestrate different agents for specific tasks.
          </p>
        </div>
        {!isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="group flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-all duration-200 shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
          >
            <Plus className="w-4 h-4 transition-transform group-hover:rotate-90 duration-300" />
            Create Workflow
          </button>
        )}
      </div>

      {error && <div className="mb-4 p-3 bg-red-500/10 text-red-500 border border-red-500/20 rounded-lg">{error}</div>}

      {isEditing ? (
        <form onSubmit={handleSave} className="bg-card border border-border/60 rounded-2xl p-7 space-y-7 mb-10 shadow-lg shadow-black/5 transition-all animate-in fade-in slide-in-from-bottom-4 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary/40 via-primary to-primary/40"></div>

          <div className="flex items-center gap-3 border-b border-border/50 pb-5">
            <div className="p-1.5 bg-primary/10 rounded-lg">
              <GitMerge className="w-5 h-5 text-primary" />
            </div>
            <h2 className="text-xl font-semibold tracking-tight">{currentId ? 'Edit Workflow' : 'Create New Workflow'}</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-7">
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2 text-foreground/90">
                <FileText className="w-4 h-4 text-primary/70" />
                Name
              </label>
              <input
                required
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-4 py-2.5 bg-background/50 border border-border/80 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all hover:bg-background"
                placeholder="e.g. Code Review Process"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2 text-foreground/90">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="w-full px-4 py-2.5 bg-background/50 border border-border/80 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all hover:bg-background"
                placeholder="Brief description of this workflow"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-2 text-foreground/90">
              <ListTree className="w-4 h-4 text-primary/70" />
              Steps <span className="text-muted-foreground font-normal">(comma separated agent IDs)</span>
            </label>
            <input
              required
              type="text"
              value={steps}
              onChange={e => setSteps(e.target.value)}
              placeholder="clarifier, planner, implementer, verifier"
              className="w-full px-4 py-2.5 bg-background/50 border border-border/80 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all font-mono hover:bg-background"
            />
            {agents.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2 items-center bg-muted/30 p-3 rounded-xl border border-border/40">
                <span className="text-xs font-medium text-muted-foreground mr-1">Available agents:</span>
                {agents.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setSteps(prev => prev ? `${prev}, ${a.id}` : a.id)}
                    className="text-[11px] px-2 py-1 bg-background/80 hover:bg-primary/10 hover:text-primary hover:border-primary/30 rounded-md border border-border text-muted-foreground transition-all cursor-pointer shadow-sm"
                  >
                    {a.id}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-3 justify-end pt-5 border-t border-border/50">
            <button type="button" onClick={resetForm} className="px-5 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80 rounded-xl transition-all">
              Cancel
            </button>
            <button type="submit" className="px-6 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm hover:shadow active:scale-[0.98]">
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 xl:gap-6">
          {workflows.map(wf => (
            <div
              key={wf.id}
              className={cn(
                "group relative bg-card border border-border/60 rounded-2xl p-6 transition-all duration-300",
                "hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 flex flex-col h-full overflow-hidden"
              )}
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none transition-opacity group-hover:opacity-100 opacity-0"></div>

              <div className="flex justify-between items-start mb-4 relative z-10">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center border border-primary/20 shrink-0 shadow-inner">
                    <GitMerge className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground text-lg tracking-tight group-hover:text-primary transition-colors">{wf.name}</h3>
                    <p className="text-xs font-mono text-muted-foreground/70 mt-0.5">{wf.id}</p>
                  </div>
                </div>

                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all translate-x-2 group-hover:translate-x-0">
                  <button
                    onClick={() => startEdit(wf)}
                    className="p-2 text-muted-foreground hover:text-blue-500 hover:bg-blue-500/10 rounded-lg transition-all"
                    title="Edit workflow"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(wf.id)}
                    className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all"
                    title="Delete workflow"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {wf.description && (
                <p className="text-sm text-muted-foreground mb-6 line-clamp-2 leading-relaxed relative z-10">{wf.description}</p>
              )}

              <div className="mt-auto pt-5 border-t border-border/40 relative z-10">
                <div className="flex items-center gap-2 mb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  <ListTree className="w-3.5 h-3.5" />
                  <span>Execution Sequence ({wf.steps.length})</span>
                </div>
                <div className="flex flex-wrap items-center gap-y-2 gap-x-1">
                  {wf.steps.map((step, index) => (
                    <div key={index} className="flex items-center">
                      <span className="text-xs font-medium px-2.5 py-1.5 bg-secondary/50 hover:bg-secondary text-secondary-foreground border border-border/50 rounded-lg transition-colors shadow-sm">
                        {step}
                      </span>
                      {index < wf.steps.length - 1 && (
                        <ChevronRight className="w-4 h-4 text-muted-foreground/40 mx-1" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}

          {workflows.length === 0 && !isEditing && (
            <div className="col-span-full flex flex-col items-center justify-center py-20 px-4 border-2 border-dashed border-border/60 rounded-2xl bg-card/30 text-center">
              <div className="w-20 h-20 bg-primary/5 rounded-full flex items-center justify-center mb-5">
                <GitMerge className="w-10 h-10 text-primary/40" />
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-2">No Workflows Configured</h3>
              <p className="text-muted-foreground max-w-sm mb-6">Create your first custom workflow to define how multiple agents should collaborate to complete tasks.</p>
              <button
                onClick={() => setIsEditing(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-all shadow-md hover:shadow-lg hover:-translate-y-0.5"
              >
                <Plus className="w-4 h-4" />
                Create First Workflow
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
