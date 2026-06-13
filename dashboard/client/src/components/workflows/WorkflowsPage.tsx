import { useEffect, useState } from 'react';
import type { CustomWorkflow } from '@devteam-dashboard/shared';

const API_BASE = import.meta.env.VITE_API_URL || '';

export function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<CustomWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // form state
  const [isEditing, setIsEditing] = useState(false);
  const [currentId, setCurrentId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');

  const fetchWorkflows = async () => {
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
    <div className="p-6 max-w-4xl mx-auto h-full overflow-y-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">Custom Workflows</h1>
        {!isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-semibold hover:bg-blue-600 transition-colors"
          >
            Create Workflow
          </button>
        )}
      </div>

      {error && <div className="mb-4 p-3 bg-red-500/10 text-red-500 border border-red-500/20 rounded">{error}</div>}

      {isEditing ? (
        <form onSubmit={handleSave} className="bg-card border border-border rounded-lg p-5 space-y-4 mb-6">
          <h2 className="text-lg font-semibold">{currentId ? 'Edit Workflow' : 'New Workflow'}</h2>

          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              required
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Steps (comma separated)</label>
            <input
              required
              type="text"
              value={steps}
              onChange={e => setSteps(e.target.value)}
              placeholder="clarifier, planner, implementer, verifier"
              className="w-full px-3 py-2 bg-muted/50 border border-border rounded-md text-sm"
            />
          </div>

          <div className="flex gap-2 justify-end">
            <button type="button" onClick={resetForm} className="px-4 py-2 text-sm text-muted-foreground hover:bg-accent rounded-md transition-colors">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-semibold hover:bg-blue-600 transition-colors">
              Save
            </button>
          </div>
        </form>
      ) : null}

      {loading && !isEditing ? (
        <p className="text-muted-foreground">Loading workflows...</p>
      ) : (
        <div className="space-y-4">
          {workflows.map(wf => (
            <div key={wf.id} className="bg-card border border-border rounded-lg p-4 flex justify-between items-center">
              <div>
                <h3 className="font-semibold">{wf.name}</h3>
                <p className="text-sm text-muted-foreground">{wf.description}</p>
                <div className="mt-2 text-xs text-blue-400 bg-blue-500/10 inline-block px-2 py-1 rounded">
                  {wf.steps.join(' → ')}
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => startEdit(wf)} className="text-sm text-blue-400 hover:text-blue-300">Edit</button>
                <button onClick={() => handleDelete(wf.id)} className="text-sm text-red-400 hover:text-red-300">Delete</button>
              </div>
            </div>
          ))}
          {workflows.length === 0 && !isEditing && (
            <p className="text-center text-muted-foreground py-8 border border-dashed border-border rounded-lg">
              No custom workflows found. Create one to get started!
            </p>
          )}
        </div>
      )}
    </div>
  );
}
