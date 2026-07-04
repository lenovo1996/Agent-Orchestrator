import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useDashboardStore } from '../../store/use-dashboard-store';

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceName: string;
}

export function DeleteWorkspaceDialog({ open, onClose, workspaceId, workspaceName }: Props) {
  const [deleteDirectory, setDeleteDirectory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const deleteWorkspace = useDashboardStore(s => s.deleteWorkspace);

  if (!open) return null;

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const success = await deleteWorkspace(workspaceId, deleteDirectory);
    setLoading(false);

    if (success) {
      onClose();
    } else {
      setError('Failed to delete workspace. Please check your connection and try again.');
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col bg-card border border-border shadow-2xl rounded-2xl overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 p-4 border-b border-border bg-muted/30">
          <h2 className="text-xl font-semibold text-foreground">Delete Workspace</h2>
          <p className="text-sm text-muted-foreground mt-1">Are you sure you want to delete workspace "{workspaceName}"?</p>
        </div>

        <form onSubmit={handleDelete} className="space-y-4 overflow-y-auto p-4">
          {error && (
            <div className="p-3 bg-red-500/10 text-red-500 text-sm border border-red-500/20 rounded-lg">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2 mt-4 bg-muted/50 p-3 rounded-lg border border-border/50">
            <input
              type="checkbox"
              id="delete-directory"
              checked={deleteDirectory}
              onChange={(e) => setDeleteDirectory(e.target.checked)}
              className="w-4 h-4 text-red-500 rounded border-input focus:ring-red-500 bg-background"
            />
            <label htmlFor="delete-directory" className="text-sm text-foreground cursor-pointer select-none">
              Also delete workspace directory
            </label>
          </div>
          <p className="text-[10px] text-muted-foreground/80 pl-6 -mt-2">
            Checking this will permanently remove the workspace directory and all its contents from disk. This action cannot be undone.
          </p>

          <div className="flex justify-end gap-2 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted rounded-lg transition-colors disabled:opacity-50"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-red-500 text-white rounded-lg text-sm font-semibold hover:bg-red-600 transition-all shadow-sm flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              ) : null}
              Delete
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}