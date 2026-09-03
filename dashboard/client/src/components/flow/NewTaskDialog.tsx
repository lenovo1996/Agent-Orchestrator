import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useDashboardStore } from '../../store/use-dashboard-store';
import type { CustomWorkflow } from '@devteam-dashboard/shared';

const API_BASE = import.meta.env.VITE_API_URL || '';

function workflowOptionTitle(workflow: CustomWorkflow): string {
  return `${workflow.name} (${workflow.steps.join(' → ')})`;
}

interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (flowId: string) => void | Promise<void>;
}

export function NewTaskDialog({ open, onClose, onSuccess }: NewTaskDialogProps) {
  const selectedWorkspaceId = useDashboardStore(s => s.selectedWorkspaceId);
  const orchestrationReady = useDashboardStore(s => s.orchestrationReady);
  const [jiraKey, setJiraKey] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [dependsOn, setDependsOn] = useState<string>('');
  const [useWorktree, setUseWorktree] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<CustomWorkflow[]>([]);
  const [improving, setImproving] = useState(false);
  const [improveError, setImproveError] = useState<string | null>(null);
  const [workflowMenuOpen, setWorkflowMenuOpen] = useState(false);
  const [activeWorkflowIndex, setActiveWorkflowIndex] = useState(0);
  const workflowSelectRef = useRef<HTMLDivElement>(null);
  const workflowTriggerRef = useRef<HTMLButtonElement>(null);
  const selectedWorkflow = workflows.find((workflow) => workflow.id === workflowId);

  useEffect(() => {
    if (open) {
      fetch(`${API_BASE}/api/workflows`)
        .then(res => res.json())
        .then(data => {
          setWorkflows(data);
          setWorkflowId((current) => current || data[0]?.id || '');
          setActiveWorkflowIndex(0);
        })
        .catch(() => console.error('Failed to load workflows'));
    } else {
      setWorkflowMenuOpen(false);
    }
  }, [open]);

  useEffect(() => {
    if (!workflowMenuOpen) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!workflowSelectRef.current?.contains(event.target as Node)) {
        setWorkflowMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [workflowMenuOpen]);

  useEffect(() => {
    if (!workflowMenuOpen) return;

    document
      .getElementById(`new-task-workflow-option-${activeWorkflowIndex}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeWorkflowIndex, workflowMenuOpen]);

  const openWorkflowMenu = () => {
    const selectedIndex = workflows.findIndex((workflow) => workflow.id === workflowId);
    setActiveWorkflowIndex(Math.max(selectedIndex, 0));
    setWorkflowMenuOpen(true);
  };

  const selectWorkflow = (workflow: CustomWorkflow) => {
    setWorkflowId(workflow.id);
    setWorkflowMenuOpen(false);
    workflowTriggerRef.current?.focus();
  };

  const handleWorkflowKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      setWorkflowMenuOpen(false);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!workflowMenuOpen) {
        openWorkflowMenu();
        return;
      }

      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveWorkflowIndex((current) => (
        (current + direction + workflows.length) % workflows.length
      ));
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!workflowMenuOpen) {
        openWorkflowMenu();
      } else if (workflows[activeWorkflowIndex]) {
        selectWorkflow(workflows[activeWorkflowIndex]);
      }
    }
  };

  const handleImprovePrompt = async () => {
    if (!customPrompt.trim()) return;
    setImproving(true);
    setImproveError(null);
    try {
      const res = await fetch(`${API_BASE}/api/improve-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: customPrompt }),
      });
      const data = await res.json();
      if (res.ok && data.improved) {
        setCustomPrompt(data.improved);
      } else {
        setImproveError(data.error || 'Failed to improve prompt');
      }
    } catch {
      setImproveError('Failed to connect to server');
    } finally {
      setImproving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!jiraKey && !customPrompt.trim()) {
      setError('Either Jira Key or Custom Prompt is required');
      return;
    }
    if (!selectedWorkspaceId || !workflowId) {
      setError('Workspace and workflow are required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: selectedWorkspaceId,
          jiraKey,
          prompt: customPrompt,
          workflowId,
          dependsOn: dependsOn.split(',').map(s => s.trim()).filter(Boolean),
          useWorktree,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        await onSuccess(data.flowId);
        setJiraKey('');
        setCustomPrompt('');
        setWorkflowId('');
        setDependsOn('');
        setUseWorktree(false);
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
          <div className="min-w-0 space-y-2">
            <label id="new-task-workflow-label" htmlFor="new-task-workflow" className="block text-sm font-medium text-foreground">
              Workflow
            </label>
            <div ref={workflowSelectRef} className="relative min-w-0 max-w-full">
              <button
                ref={workflowTriggerRef}
                id="new-task-workflow"
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={workflowMenuOpen}
                aria-controls="new-task-workflow-options"
                aria-activedescendant={workflowMenuOpen ? `new-task-workflow-option-${activeWorkflowIndex}` : undefined}
                disabled={workflows.length === 0}
                title={selectedWorkflow ? workflowOptionTitle(selectedWorkflow) : undefined}
                onClick={() => workflowMenuOpen ? setWorkflowMenuOpen(false) : openWorkflowMenu()}
                onKeyDown={handleWorkflowKeyDown}
                className={cn(
                  'flex w-full min-w-0 max-w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm',
                  'bg-muted/50 border border-border text-foreground',
                  'focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500',
                  'transition-colors disabled:cursor-not-allowed disabled:opacity-60'
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{selectedWorkflow?.name || 'Select a workflow'}</span>
                  {selectedWorkflow && (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {selectedWorkflow.steps.join(' → ')}
                    </span>
                  )}
                </span>
                <svg
                  aria-hidden="true"
                  className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', workflowMenuOpen && 'rotate-180')}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {workflowMenuOpen && (
                <div
                  id="new-task-workflow-options"
                  role="listbox"
                  aria-labelledby="new-task-workflow-label"
                  className="absolute inset-x-0 z-20 mt-1 max-h-64 w-full max-w-full overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-xl"
                >
                  {workflows.map((workflow, index) => (
                    <button
                      key={workflow.id}
                      id={`new-task-workflow-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={workflow.id === workflowId}
                      title={workflowOptionTitle(workflow)}
                      onMouseEnter={() => setActiveWorkflowIndex(index)}
                      onClick={() => selectWorkflow(workflow)}
                      className={cn(
                        'block w-full min-w-0 rounded-md px-3 py-2 text-left transition-colors',
                        index === activeWorkflowIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                      )}
                    >
                      <span className="block break-words text-sm font-medium">{workflow.name}</span>
                      <span className="mt-1 block break-words text-xs leading-5 text-muted-foreground">
                        {workflow.steps.join(' → ')}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              The selected definition is snapshotted when the flow is queued
            </p>
          </div>

          <label className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(event) => setUseWorktree(event.target.checked)}
            />
            Run in an isolated git worktree
          </label>

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
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Provide additional instructions or context for the dev-team agents
              </p>
              <button
                type="button"
                onClick={handleImprovePrompt}
                disabled={improving || !customPrompt.trim()}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                  'bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {improving ? (
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
                  </svg>
                )}
                {improving ? 'Improving...' : 'Improve'}
              </button>
            </div>
            {improveError && (
              <p className="text-xs text-red-400">{improveError}</p>
            )}
          </div>

          {/* Depends On */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Depends On <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              type="text"
              value={dependsOn}
              onChange={(e) => setDependsOn(e.target.value)}
              placeholder="e.g. flow_123, flow_456"
              className={cn(
                'w-full px-3 py-2 rounded-lg text-sm',
                'bg-muted/50 border border-border',
                'text-foreground placeholder:text-muted-foreground',
                'focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500',
                'transition-colors'
              )}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated flow IDs that must complete before this workflow starts
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
              disabled={loading || orchestrationReady === false || !selectedWorkspaceId || !workflowId || (!jiraKey && !customPrompt.trim())}
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
              {loading ? 'Queueing...' : orchestrationReady === false ? 'Orchestrator unavailable' : 'Queue Workflow'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
