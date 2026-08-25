import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentConfig, CustomWorkflow } from '@devteam-dashboard/shared';
import {
  AlertTriangle, ArrowDown, ArrowUp, Bot, BrainCircuit, CheckCircle2, ChevronRight,
  FileOutput, GitMerge, ListTree, Pencil, Plus, RefreshCw, Search, TerminalSquare,
  Trash2, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const API_BASE = import.meta.env.VITE_API_URL || '';
type StepField = { key: number; value: string };
let nextStepKey = 0;

function createStep(value = ''): StepField {
  nextStepKey += 1;
  return { key: nextStepKey, value };
}

function parseNeedsFix(value: string): Record<string, string> {
  if (!value.trim()) return {};
  return Object.fromEntries(value.split(',').map((entry) => {
    const [gate, target, ...rest] = entry.split('=').map((part) => part.trim());
    if (!gate || !target || rest.length) {
      throw new Error(`Invalid NEEDS_FIX route “${entry.trim()}”. Use gate=target.`);
    }
    return [gate, target];
  }));
}

function formatNeedsFix(value: Record<string, string>): string {
  return Object.entries(value).map(([gate, target]) => `${gate}=${target}`).join(', ');
}

async function getResponseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown; message?: unknown };
    if (typeof body.message === 'string' && body.message) return body.message;
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // The API may return an empty or non-JSON error response.
  }
  return fallback;
}

export function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<CustomWorkflow[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentReferencesUnavailable, setAgentReferencesUnavailable] = useState(false);
  const [query, setQuery] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [currentId, setCurrentId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<StepField[]>([createStep()]);
  const [context, setContext] = useState('');
  const [needsFix, setNeedsFix] = useState('');
  const [version, setVersion] = useState(1);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchCatalog = async () => {
    setLoading(true);
    setLoadError(null);
    const [workflowResult, agentResult] = await Promise.allSettled([
      fetch(`${API_BASE}/api/workflows`),
      fetch(`${API_BASE}/api/agents`),
    ]);

    if (agentResult.status === 'fulfilled' && agentResult.value.ok) {
      try {
        setAgents(await agentResult.value.json() as AgentConfig[]);
        setAgentReferencesUnavailable(false);
      } catch {
        setAgentReferencesUnavailable(true);
      }
    } else {
      setAgentReferencesUnavailable(true);
    }

    if (workflowResult.status === 'fulfilled') {
      if (workflowResult.value.ok) {
        try {
          setWorkflows(await workflowResult.value.json() as CustomWorkflow[]);
        } catch {
          setLoadError('The workflow catalog returned an invalid response.');
        }
      } else {
        setLoadError(await getResponseError(workflowResult.value, 'Failed to load workflows.'));
      }
    } else {
      setLoadError('Unable to connect to the workflow catalog.');
    }
    setLoading(false);
  };

  useEffect(() => {
    void fetchCatalog();
  }, []);

  const resetForm = () => {
    setCurrentId('');
    setName('');
    setDescription('');
    setSteps([createStep()]);
    setContext('');
    setNeedsFix('');
    setVersion(1);
    setIsEditing(false);
    setMutationError(null);
  };

  const startNew = () => {
    resetForm();
    setSuccessMessage(null);
    setIsEditing(true);
  };

  const startEdit = (workflow: CustomWorkflow) => {
    setCurrentId(workflow.id);
    setName(workflow.name);
    setDescription(workflow.description);
    setSteps((workflow.steps.length ? workflow.steps : ['']).map((step) => createStep(step)));
    setContext(workflow.context);
    setNeedsFix(formatNeedsFix(workflow.needsFix));
    setVersion(workflow.version);
    setMutationError(null);
    setSuccessMessage(null);
    setIsEditing(true);
  };

  const updateStep = useCallback((key: number, value: string) => {
    setSteps((current) => current.map((step) => step.key === key ? { ...step, value } : step));
  }, []);

  const moveStep = useCallback((index: number, direction: -1 | 1) => {
    setSteps((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
      return reordered;
    });
  }, []);

  const removeStep = useCallback((key: number) => {
    setSteps((current) => current.length === 1
      ? current.map((step) => ({ ...step, value: '' }))
      : current.filter((step) => step.key !== key));
  }, []);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMutationError(null);
    setSuccessMessage(null);
    try {
      const stepIds = steps.map((step) => step.value.trim()).filter(Boolean);
      if (!stepIds.length) throw new Error('Add at least one agent step.');
      const payload = {
        id: currentId || `wf_${Date.now()}`,
        name,
        description,
        steps: stepIds,
        context,
        needsFix: parseNeedsFix(needsFix),
        version,
      };
      const response = await fetch(
        currentId ? `${API_BASE}/api/workflows/${currentId}` : `${API_BASE}/api/workflows`,
        {
          method: currentId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) throw new Error(await getResponseError(response, 'Failed to save workflow.'));
      const action = currentId ? 'updated' : 'created';
      resetForm();
      await fetchCatalog();
      setSuccessMessage(`Workflow ${action} successfully.`);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to save workflow.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (deletingId || !window.confirm('Are you sure you want to delete this workflow?')) return;
    setDeletingId(id);
    setMutationError(null);
    setSuccessMessage(null);
    try {
      const response = await fetch(`${API_BASE}/api/workflows/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await getResponseError(response, 'Failed to delete workflow.'));
      await fetchCatalog();
      setSuccessMessage('Workflow deleted successfully.');
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to delete workflow.');
    } finally {
      setDeletingId(null);
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredWorkflows = useMemo(() => workflows.filter((workflow) => {
    if (!normalizedQuery) return true;
    return [workflow.id, workflow.name, workflow.description, ...workflow.steps]
      .some((value) => value.toLowerCase().includes(normalizedQuery));
  }), [normalizedQuery, workflows]);
  const totalSteps = workflows.reduce((sum, workflow) => sum + workflow.steps.length, 0);
  const feedbackWorkflows = workflows.filter((workflow) => Object.keys(workflow.needsFix).length > 0).length;
  const knownAgentIds = new Set(agents.map((agent) => agent.id));

  return (
    <div className="h-full overflow-y-auto bg-background/50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="rounded-xl bg-primary/10 p-2 text-primary"><GitMerge className="h-6 w-6" /></span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Orchestration catalog</p>
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Workflows</h1>
              </div>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">Define execution order, shared policy, and feedback routes for reusable agent workflows.</p>
          </div>
          {!isEditing && (
            <button type="button" onClick={startNew} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto">
              <Plus className="h-4 w-4" /> Create Workflow
            </button>
          )}
        </header>

        <div aria-live="polite" className="space-y-3">
          {successMessage && <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {successMessage}</div>}
          {mutationError && <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {mutationError}</div>}
          {agentReferencesUnavailable && <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Agent references cannot be verified right now. Workflow data is still available.</div>}
        </div>

        {isEditing && (
          <Card className="overflow-hidden border-primary/20 shadow-md">
            <form onSubmit={handleSave}>
              <CardHeader className="border-b border-border/70 bg-muted/20 p-5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div><p className="text-xs font-semibold uppercase tracking-wider text-primary">Workflow workspace</p><CardTitle className="mt-1 text-xl">{currentId ? 'Edit workflow' : 'Create workflow'}</CardTitle></div>
                  <button type="button" aria-label="Close workflow editor" onClick={resetForm} disabled={saving} className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><X className="h-4 w-4" /></button>
                </div>
              </CardHeader>
              <CardContent className="space-y-8 p-5 sm:p-6">
                <fieldset className="space-y-4">
                  <legend className="text-sm font-semibold">General</legend>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2"><label htmlFor="workflow-name" className="text-sm font-medium">Name</label><input id="workflow-name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Code review process" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                    <div className="space-y-2"><label htmlFor="workflow-version" className="text-sm font-medium">Version</label><input id="workflow-version" type="number" min={1} required value={version} onChange={(event) => setVersion(Number(event.target.value) || 1)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                  </div>
                  <div className="space-y-2"><label htmlFor="workflow-description" className="text-sm font-medium">Description</label><input id="workflow-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this workflow coordinates" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                </fieldset>

                <fieldset className="space-y-4">
                  <div><legend className="text-sm font-semibold">Execution sequence</legend><p className="mt-1 text-xs text-muted-foreground">Steps run from top to bottom. Reorder them with the arrow controls; existing unknown references are preserved.</p></div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setSteps((current) => [...current, createStep()])} disabled={saving} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Plus className="h-3.5 w-3.5" /> Add empty step</button>
                    {agents.map((agent) => <button key={agent.id} type="button" onClick={() => setSteps((current) => [...current, createStep(agent.id)])} disabled={saving} className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">+ {agent.id}</button>)}
                  </div>
                  <ol aria-label="Workflow execution editor" className="space-y-3">
                    {steps.map((step, index) => {
                      const agent = agents.find((candidate) => candidate.id === step.value);
                      const isMissing = Boolean(step.value && !agent && !agentReferencesUnavailable);
                      return (
                        <li key={step.key} className={cn('rounded-xl border border-border bg-muted/10 p-4', isMissing && 'border-amber-500/50 bg-amber-500/5')}>
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-bold text-primary" aria-hidden="true">{index + 1}</span>
                            <div className="min-w-0 flex-1 space-y-3">
                              <div className="space-y-2">
                                <label htmlFor={`workflow-step-${step.key}`} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Agent for step {index + 1}</label>
                                <input id={`workflow-step-${step.key}`} required list="workflow-agent-options" value={step.value} onChange={(event) => updateStep(step.key, event.target.value)} disabled={saving} placeholder="agent-id" className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
                              </div>
                              {agent ? (
                                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                                  <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-2"><Bot className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{agent.role}</span></span>
                                  <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-2"><BrainCircuit className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{agent.model || 'Default model'}</span></span>
                                  <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-2"><TerminalSquare className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{agent.runtime || 'Default runtime'}</span></span>
                                  <span className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-2"><FileOutput className="h-3.5 w-3.5" />{agent.outputs.length} outputs</span>
                                </div>
                              ) : isMissing ? (
                                <p className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-200"><AlertTriangle className="h-4 w-4 shrink-0" /> Missing agent reference. It will be preserved unless you change or remove this step.</p>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 items-center justify-end gap-1">
                              <button type="button" aria-label={`Move step ${index + 1} up`} onClick={() => moveStep(index, -1)} disabled={index === 0 || saving} className="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                              <button type="button" aria-label={`Move step ${index + 1} down`} onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1 || saving} className="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                              <button type="button" aria-label={`Remove step ${index + 1}`} onClick={() => removeStep(step.key)} disabled={saving} className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Trash2 className="h-4 w-4" /></button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                  <datalist id="workflow-agent-options">{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.role}</option>)}</datalist>
                </fieldset>

                <fieldset className="space-y-4">
                  <legend className="text-sm font-semibold">Policy and feedback</legend>
                  <div className="space-y-2"><label htmlFor="workflow-policy" className="text-sm font-medium">Shared workflow policy</label><textarea id="workflow-policy" rows={4} value={context} onChange={(event) => setContext(event.target.value)} placeholder="Policy and constraints injected into each agent prompt" className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                  <div className="space-y-2"><label htmlFor="workflow-needs-fix" className="text-sm font-medium">NEEDS_FIX routing</label><input id="workflow-needs-fix" value={needsFix} onChange={(event) => setNeedsFix(event.target.value)} placeholder="reviewer=implementer, audit=block" aria-describedby="workflow-needs-fix-help" className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /><p id="workflow-needs-fix-help" className="text-xs text-muted-foreground">Enter comma-separated gate=target routes. Use gate=block for a read-only audit.</p></div>
                </fieldset>

                <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-end">
                  <button type="button" onClick={resetForm} disabled={saving} className="rounded-lg px-4 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">Cancel</button>
                  <button type="submit" disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60">{saving && <RefreshCw className="h-4 w-4 animate-spin" />} {saving ? 'Saving…' : 'Save Workflow'}</button>
                </div>
              </CardContent>
            </form>
          </Card>
        )}

        {!loading && !loadError && <section aria-label="Workflow overview" className="grid gap-3 sm:grid-cols-3">{[
          ['Workflows', workflows.length], ['Agent steps', totalSteps], ['Workflows with feedback routing', feedbackWorkflows],
        ].map(([label, value]) => <Card key={label} className="bg-card/70"><CardContent className="p-4"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p></CardContent></Card>)}</section>}

        {!loadError && workflows.length > 0 && (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 flex-1 sm:max-w-xl"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><label htmlFor="workflow-search" className="sr-only">Search workflows</label><input id="workflow-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, ID, description, or agent…" className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
            <div className="flex items-center justify-between gap-3 sm:justify-end"><span className="text-xs text-muted-foreground">Showing {filteredWorkflows.length} of {workflows.length}</span>{query && <button type="button" onClick={() => setQuery('')} className="text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Clear search</button>}</div>
          </div>
        )}

        {loading ? (
          <div role="status" className="flex items-center justify-center gap-3 rounded-xl border border-border py-16 text-sm text-muted-foreground"><RefreshCw className="h-5 w-5 animate-spin" /> Loading workflows…</div>
        ) : loadError ? (
          <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center"><AlertTriangle className="mx-auto h-7 w-7 text-destructive" /><h2 className="mt-3 font-semibold">Workflows could not be loaded</h2><p className="mt-1 text-sm text-muted-foreground">{loadError}</p><button type="button" onClick={() => void fetchCatalog()} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><RefreshCw className="h-4 w-4" /> Retry</button></div>
        ) : filteredWorkflows.length > 0 ? (
          <section aria-label="Workflow catalog" className="grid gap-4 xl:grid-cols-2">
            {filteredWorkflows.map((workflow) => {
              const missingAgents = agentReferencesUnavailable ? [] : workflow.steps.filter((step) => !knownAgentIds.has(step));
              return (
                <Card key={workflow.id} role="article" className={cn('flex min-w-0 flex-col overflow-hidden', missingAgents.length > 0 && 'border-amber-500/40')}>
                  <CardHeader className="space-y-4 p-5">
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><CardTitle className="break-words text-lg">{workflow.name}</CardTitle><Badge variant="outline">v{workflow.version}</Badge><Badge variant="secondary">{workflow.steps.length} steps</Badge></div><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{workflow.id}</p></div>
                      <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto"><button type="button" aria-label={`Edit workflow ${workflow.name}`} onClick={() => startEdit(workflow)} disabled={Boolean(deletingId)} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Pencil className="h-3.5 w-3.5" /> Edit</button><button type="button" aria-label={`Delete workflow ${workflow.name}`} onClick={() => void handleDelete(workflow.id)} disabled={Boolean(deletingId)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /> {deletingId === workflow.id ? 'Deleting…' : 'Delete'}</button></div>
                    </div>
                    {workflow.description && <p className="text-sm leading-6 text-muted-foreground">{workflow.description}</p>}
                    {missingAgents.length > 0 && <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Missing agent reference{missingAgents.length > 1 ? 's' : ''}: {missingAgents.join(', ')}</div>}
                  </CardHeader>
                  <CardContent className="mt-auto space-y-5 border-t border-border/60 p-5">
                    <div><div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><ListTree className="h-4 w-4" /> Execution sequence</div><div className="flex flex-wrap items-center gap-1.5">{workflow.steps.map((step, index) => <div key={`${step}-${index}`} className="flex min-w-0 items-center gap-1.5"><Badge variant="secondary" className={cn('max-w-full break-all font-mono font-medium', missingAgents.includes(step) && 'border border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200')}>{index + 1}. {step}</Badge>{index < workflow.steps.length - 1 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}</div>)}</div></div>
                    {workflow.context && <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Shared policy</p><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-foreground/80">{workflow.context}</p></div>}
                    <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Feedback routing</p>{Object.keys(workflow.needsFix).length ? <div className="mt-2 flex flex-wrap gap-2">{Object.entries(workflow.needsFix).map(([gate, target]) => <Badge key={gate} variant="outline" className="break-all font-mono">{gate} → {target}</Badge>)}</div> : <p className="mt-2 text-sm text-muted-foreground">No NEEDS_FIX routes configured.</p>}</div>
                  </CardContent>
                </Card>
              );
            })}
          </section>
        ) : workflows.length > 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center"><Search className="mx-auto h-8 w-8 text-muted-foreground/50" /><h2 className="mt-3 font-semibold">No workflows match your search</h2><p className="mt-1 text-sm text-muted-foreground">Try another term or reset the current search.</p><button type="button" onClick={() => setQuery('')} className="mt-4 text-sm font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Reset search</button></div>
        ) : (
          <div className="rounded-xl border border-dashed border-border p-10 text-center"><GitMerge className="mx-auto h-9 w-9 text-primary/50" /><h2 className="mt-3 text-lg font-semibold">No workflows configured</h2><p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Create a workflow to coordinate an ordered sequence of agents.</p>{!isEditing && <button type="button" onClick={startNew} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Plus className="h-4 w-4" /> Create Workflow</button>}</div>
        )}
      </div>
    </div>
  );
}
