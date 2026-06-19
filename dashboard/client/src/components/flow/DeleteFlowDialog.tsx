import { useState } from 'react';
import type { WorkflowState } from '@devteam-dashboard/shared';
import { useDashboardStore } from '@/store/use-dashboard-store';

const API_BASE = import.meta.env.VITE_API_URL || '';

interface DeleteFlowDialogProps {
  flow: WorkflowState;
  onClose: () => void;
}

export function DeleteFlowDialog({ flow, onClose }: DeleteFlowDialogProps) {
  const [deleteMemory, setDeleteMemory] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteFlowLocally = useDashboardStore((s) => s.deleteFlowLocally);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const res = await fetch(`${API_BASE}/api/flows/${flow.flowId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteMemory }),
      });

      if (!res.ok) {
        throw new Error('Failed to delete flow');
      }

      deleteFlowLocally(flow.flowId);
      onClose();
    } catch (err) {
      console.error(err);
      alert('Failed to delete flow.');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold text-foreground">
            Delete Flow: {flow.jiraKey}
          </h3>
          <p className="text-xs text-muted-foreground">
            Are you sure you want to delete this flow? This action cannot be undone.
          </p>
        </div>

        <div className="flex items-center gap-2 mt-4 bg-muted/50 p-3 rounded-lg border border-border/50">
          <input
            type="checkbox"
            id="delete-memory"
            checked={deleteMemory}
            onChange={(e) => setDeleteMemory(e.target.checked)}
            className="w-4 h-4 text-red-500 rounded border-input focus:ring-red-500 bg-background"
          />
          <label htmlFor="delete-memory" className="text-sm text-foreground cursor-pointer select-none">
            Also delete memory context
          </label>
        </div>
        <p className="text-[10px] text-muted-foreground/80 pl-6 -mt-2">
          Checking this will remove all associated memory data for this flow (e.g. meta.json, tree.json).
        </p>

        <div className="flex justify-end gap-2 pt-4">
          <button
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={isDeleting}
            className="px-4 py-2 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isDeleting ? 'Deleting...' : 'Delete Flow'}
          </button>
        </div>
      </div>
    </div>
  );
}
