import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { CustomWorkflow } from '@devteam-dashboard/shared';

const API_BASE = import.meta.env.VITE_API_URL || '';

interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (flowId: string) => void;
}

export function NewTaskDialog({ open, onClose, onSuccess }: NewTaskDialogProps) {
  const [jiraKey, setJiraKey] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<CustomWorkflow[]>([]);

  useEffect(() => {
    if (open) {
      fetch(`${API_BASE}/api/workflows`)
        .then(res => res.json())
        .then(data => setWorkflows(data))
        .catch(() => console.error('Failed to load workflows'));
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!jiraKey && !customPrompt.trim()) {
      setError('Either Jira Key or Custom Prompt is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/flows/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jiraKey, customPrompt, workflowId }),
      });

      const data = await res.json();

      if (res.ok) {
        onSuccess(data.flowId);
        setJiraKey('');
        setCustomPrompt('');
        onClose();
      } else {
        setError(data.error || 'Failed to start workflow');
      }
    } catch (err) {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative z-10 w-full max-w-lg mx-4 bg-card border border-border rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Start New Task</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Create a new dev-team workflow</p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Workflow Selection */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Workflow <span className="text-muted-foreground">(optional)</span>
            </label>
            <select
              value={workflowId}
              onChange={(e) => setWorkflowId(e.target.value)}
              className={cn(
                'w-full px-3 py-2 rounded-lg text-sm',
                'bg-muted/50 border border-border',
                'text-foreground',
                'focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500',
                'transition-colors'
              )}
            >
              <option value="">Default (5 steps)</option>
              {workflows.map(wf => (
                <option key={wf.id} value={wf.id}>{wf.name} ({wf.steps.join(' → ')})</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Select a custom workflow or use the default
            </p>
          </div>

          {/* Jira Key */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Jira Key <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              type="text"
              value={jiraKey}
              onChange={(e) => setJiraKey(e.target.value)}
              placeholder="e.g., JH-40515"
              className={cn(
                'w-full px-3 py-2 rounded-lg text-sm',
                'bg-muted/50 border border-border',
                'text-foreground placeholder:text-muted-foreground',
                'focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500',
                'transition-colors'
              )}
            />
            <p className="text-xs text-muted-foreground">
              Enter Jira ticket key (e.g., JH-12345)
            </p>
          </div>

          {/* Custom Prompt */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Custom Prompt <span className="text-muted-foreground">(optional)</span>
            </label>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Describe your task or provide additional context..."
              rows={5}
              className={cn(
                'w-full px-3 py-2 rounded-lg text-sm resize-none',
                'bg-muted/50 border border-border',
                'text-foreground placeholder:text-muted-foreground',
                'focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500',
                'transition-colors'
              )}
            />
            <p className="text-xs text-muted-foreground">
              Provide additional instructions or context for the dev-team agents
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/20">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {error}
            </div>
          )}

          {/* Note */}
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-xs text-blue-400">
              At least one field (Jira Key or Custom Prompt) must be filled in to start a workflow.
            </p>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium transition-all',
                'bg-muted text-muted-foreground border border-border',
                'hover:bg-accent hover:text-foreground',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || (!jiraKey && !customPrompt.trim())}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium transition-all',
                'bg-blue-500 text-white border border-blue-600',
                'hover:bg-blue-600',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'flex items-center gap-2'
              )}
            >
              {loading && (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              )}
              {loading ? 'Starting...' : 'Start Workflow'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
