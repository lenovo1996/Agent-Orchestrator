import React, { useState } from 'react';
import { useDashboardStore } from '../../store/use-dashboard-store';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NewWorkspaceDialog({ open, onClose }: Props) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const createWorkspace = useDashboardStore(s => s.createWorkspace);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) {
      setError('Both name and path are required.');
      return;
    }

    setLoading(true);
    setError('');

    const success = await createWorkspace(name, path);
    setLoading(false);

    if (success) {
      setName('');
      setPath('');
      onClose();
    } else {
      setError('Failed to create workspace. Please check your connection and try again.');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="w-full max-w-md bg-card border border-border shadow-2xl rounded-2xl overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border bg-muted/30">
          <h2 className="text-xl font-semibold text-foreground">Add New Workspace</h2>
          <p className="text-sm text-muted-foreground mt-1">Configure a new independent project</p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div className="p-3 bg-red-500/10 text-red-500 text-sm border border-red-500/20 rounded-lg">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              Workspace Name
            </label>
            <input
              required
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              placeholder="e.g. Project Alpha"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              Absolute Path
            </label>
            <input
              required
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              placeholder="e.g. /home/user/projects/alpha"
            />
            <p className="text-xs text-muted-foreground mt-1">Please paste the absolute path to your project folder.</p>
          </div>

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted rounded-lg transition-colors"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-blue-500 text-white rounded-lg text-sm font-semibold hover:bg-blue-600 transition-all shadow-sm flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              ) : null}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
