import { useEffect, useMemo, useState } from 'react';
import type { AgentConfig, CustomWorkflow } from '@devteam-dashboard/shared';
import {
  AlertTriangle, Bot, BrainCircuit, CheckCircle2, FileOutput, Pencil, Plus,
  RefreshCw, Search, TerminalSquare, Trash2, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboardStore } from '@/store/use-dashboard-store';

const API_BASE = import.meta.env.VITE_API_URL || '';

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

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [workflows, setWorkflows] = useState<CustomWorkflow[]>([]);
  const setStoreAgents = useDashboardStore((state) => state.setAgents);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workflowUsageUnavailable, setWorkflowUsageUnavailable] = useState(false);
  const [query, setQuery] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [currentId, setCurrentId] = useState('');
  const [role, setRole] = useState('');
  const [objective, setObjective] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');
  const [runtime, setRuntime] = useState('');
  const [runtimeCommand, setRuntimeCommand] = useState('');
  const [outputs, setOutputs] = useState('');
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchCatalog = async () => {
    setLoading(true);
    setLoadError(null);
    const [agentResult, workflowResult] = await Promise.allSettled([
      fetch(`${API_BASE}/api/agents`),
      fetch(`${API_BASE}/api/workflows`),
    ]);

    if (workflowResult.status === 'fulfilled' && workflowResult.value.ok) {
      try {
        setWorkflows(await workflowResult.value.json() as CustomWorkflow[]);
        setWorkflowUsageUnavailable(false);
      } catch {
        setWorkflowUsageUnavailable(true);
      }
    } else {
      setWorkflowUsageUnavailable(true);
    }

    if (agentResult.status === 'fulfilled') {
      if (agentResult.value.ok) {
        try {
          const data = await agentResult.value.json() as AgentConfig[];
          setAgents(data);
          setStoreAgents(data);
        } catch {
          setLoadError('The agent catalog returned an invalid response.');
        }
      } else {
        setLoadError(await getResponseError(agentResult.value, 'Failed to load agents.'));
      }
    } else {
      setLoadError('Unable to connect to the agent catalog.');
    }
    setLoading(false);
  };

  useEffect(() => {
    void fetchCatalog();
  }, []);

  const resetForm = () => {
    setCurrentId('');
    setRole('');
    setObjective('');
    setModel('');
    setThinking('');
    setRuntime('');
    setRuntimeCommand('');
    setOutputs('');
    setInstructions('');
    setIsEditing(false);
    setIsNew(false);
    setMutationError(null);
  };

  const startNew = () => {
    resetForm();
    setSuccessMessage(null);
    setIsEditing(true);
    setIsNew(true);
  };

  const startEdit = (agent: AgentConfig) => {
    setCurrentId(agent.id);
    setRole(agent.role);
    setObjective(agent.objective);
    setModel(agent.model || '');
    setThinking(agent.thinking || '');
    setRuntime(agent.runtime || '');
    setRuntimeCommand(agent.runtimeCommand || '');
    setOutputs(agent.outputs.join(', '));
    setInstructions(agent.instructions);
    setMutationError(null);
    setSuccessMessage(null);
    setIsEditing(true);
    setIsNew(false);
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMutationError(null);
    setSuccessMessage(null);
    try {
      const payload: AgentConfig = {
        id: currentId,
        role,
        objective,
        model,
        thinking,
        tools: [],
        outputs: outputs.split(',').map((value) => value.trim()).filter(Boolean),
        runtime,
        runtimeCommand,
        instructions,
      };
      const response = await fetch(
        isNew ? `${API_BASE}/api/agents` : `${API_BASE}/api/agents/${currentId}`,
        {
          method: isNew ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) throw new Error(await getResponseError(response, 'Failed to save agent.'));
      const action = isNew ? 'created' : 'updated';
      resetForm();
      await fetchCatalog();
      setSuccessMessage(`Agent ${action} successfully.`);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to save agent.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (deletingId || !window.confirm('Are you sure you want to delete this agent?')) return;
    setDeletingId(id);
    setMutationError(null);
    setSuccessMessage(null);
    try {
      const response = await fetch(`${API_BASE}/api/agents/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await getResponseError(response, 'Failed to delete agent.'));
      await fetchCatalog();
      setSuccessMessage('Agent deleted successfully.');
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to delete agent.');
    } finally {
      setDeletingId(null);
    }
  };

  const usageByAgent = useMemo(() => {
    const usage = new Map<string, CustomWorkflow[]>();
    workflows.forEach((workflow) => {
      new Set(workflow.steps).forEach((agentId) => {
        usage.set(agentId, [...(usage.get(agentId) || []), workflow]);
      });
    });
    return usage;
  }, [workflows]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredAgents = useMemo(() => agents.filter((agent) => {
    if (!normalizedQuery) return true;
    return [
      agent.id, agent.role, agent.objective, agent.model || '', agent.thinking || '',
      agent.runtime || '', agent.runtimeCommand || '', ...agent.outputs,
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
  }), [agents, normalizedQuery]);
  const usedAgents = agents.filter((agent) => (usageByAgent.get(agent.id)?.length || 0) > 0).length;

  return (
    <div className="h-full overflow-y-auto bg-background/50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="rounded-xl bg-primary/10 p-2 text-primary"><Bot className="h-6 w-6" /></span>
              <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Capability catalog</p><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Agents</h1></div>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">Manage agent capabilities, runtime configuration, outputs, and workflow usage.</p>
          </div>
          {!isEditing && <button type="button" onClick={startNew} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"><Plus className="h-4 w-4" /> Create Agent</button>}
        </header>

        <div aria-live="polite" className="space-y-3">
          {successMessage && <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {successMessage}</div>}
          {mutationError && <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {mutationError}</div>}
          {workflowUsageUnavailable && <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Workflow usage cannot be calculated right now. Agent data is still available.</div>}
        </div>

        {isEditing && (
          <Card className="overflow-hidden border-primary/20 shadow-md">
            <form onSubmit={handleSave}>
              <CardHeader className="border-b border-border/70 bg-muted/20 p-5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div><p className="text-xs font-semibold uppercase tracking-wider text-primary">Agent workspace</p><CardTitle className="mt-1 text-xl">{isNew ? 'Create agent' : 'Edit agent'}</CardTitle></div>
                  <button type="button" aria-label="Close agent editor" onClick={resetForm} disabled={saving} className="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><X className="h-4 w-4" /></button>
                </div>
              </CardHeader>
              <CardContent className="space-y-8 p-5 sm:p-6">
                <fieldset className="space-y-4">
                  <legend className="text-sm font-semibold">Identity and purpose</legend>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2"><label htmlFor="agent-id" className="text-sm font-medium">Agent ID</label><input id="agent-id" required disabled={!isNew || saving} value={currentId} onChange={(event) => setCurrentId(event.target.value)} aria-describedby="agent-id-help" placeholder="researcher" className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60" /><p id="agent-id-help" className="text-xs text-muted-foreground">Used by workflow steps and cannot be changed after creation.</p></div>
                    <div className="space-y-2"><label htmlFor="agent-role" className="text-sm font-medium">Role</label><input id="agent-role" required value={role} onChange={(event) => setRole(event.target.value)} placeholder="Research specialist" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                  </div>
                  <div className="space-y-2"><label htmlFor="agent-objective" className="text-sm font-medium">Objective</label><input id="agent-objective" required value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="What this agent is responsible for" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                </fieldset>

                <fieldset className="space-y-4">
                  <legend className="text-sm font-semibold">Model and runtime</legend>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-2"><label htmlFor="agent-model" className="text-sm font-medium">Model</label><input id="agent-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-5" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                    <div className="space-y-2"><label htmlFor="agent-thinking" className="text-sm font-medium">Thinking</label><input id="agent-thinking" value={thinking} onChange={(event) => setThinking(event.target.value)} placeholder="high" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                    <div className="space-y-2"><label htmlFor="agent-runtime" className="text-sm font-medium">Runtime</label><input id="agent-runtime" value={runtime} onChange={(event) => setRuntime(event.target.value)} placeholder="codex" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                    <div className="space-y-2"><label htmlFor="agent-runtime-command" className="text-sm font-medium">Runtime command</label><input id="agent-runtime-command" value={runtimeCommand} onChange={(event) => setRuntimeCommand(event.target.value)} placeholder="Optional command" className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                  </div>
                </fieldset>

                <fieldset className="space-y-4">
                  <legend className="text-sm font-semibold">Output and instructions</legend>
                  <div className="space-y-2"><label htmlFor="agent-outputs" className="text-sm font-medium">Outputs</label><input id="agent-outputs" value={outputs} onChange={(event) => setOutputs(event.target.value)} aria-describedby="agent-outputs-help" placeholder="output/research.md" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /><p id="agent-outputs-help" className="text-xs text-muted-foreground">Comma-separated output paths. Runtime access is automatically scoped to the workspace and this flow's artifact directory.</p></div>
                  <div className="space-y-2"><label htmlFor="agent-instructions" className="text-sm font-medium">Instructions prompt</label><textarea id="agent-instructions" required rows={8} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="System instructions for this agent" className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
                </fieldset>

                <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-end">
                  <button type="button" onClick={resetForm} disabled={saving} className="rounded-lg px-4 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">Cancel</button>
                  <button type="submit" disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60">{saving && <RefreshCw className="h-4 w-4 animate-spin" />} {saving ? 'Saving…' : 'Save Agent'}</button>
                </div>
              </CardContent>
            </form>
          </Card>
        )}

        {!loading && !loadError && <section aria-label="Agent overview" className="grid gap-3 sm:grid-cols-3">{[
          ['Agents', agents.length], ['Used by workflows', workflowUsageUnavailable ? '—' : usedAgents], ['Not referenced', workflowUsageUnavailable ? '—' : agents.length - usedAgents],
        ].map(([label, value]) => <Card key={label} className="bg-card/70"><CardContent className="p-4"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p></CardContent></Card>)}</section>}

        {!loadError && agents.length > 0 && (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 flex-1 sm:max-w-xl"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><label htmlFor="agent-search" className="sr-only">Search agents</label><input id="agent-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search capabilities, runtime, or outputs…" className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
            <div className="flex items-center justify-between gap-3 sm:justify-end"><span className="text-xs text-muted-foreground">Showing {filteredAgents.length} of {agents.length}</span>{query && <button type="button" onClick={() => setQuery('')} className="text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Clear search</button>}</div>
          </div>
        )}

        {loading ? (
          <div role="status" className="flex items-center justify-center gap-3 rounded-xl border border-border py-16 text-sm text-muted-foreground"><RefreshCw className="h-5 w-5 animate-spin" /> Loading agents…</div>
        ) : loadError ? (
          <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center"><AlertTriangle className="mx-auto h-7 w-7 text-destructive" /><h2 className="mt-3 font-semibold">Agents could not be loaded</h2><p className="mt-1 text-sm text-muted-foreground">{loadError}</p><button type="button" onClick={() => void fetchCatalog()} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><RefreshCw className="h-4 w-4" /> Retry</button></div>
        ) : filteredAgents.length > 0 ? (
          <section aria-label="Agent catalog" className="grid gap-4 xl:grid-cols-2">
            {filteredAgents.map((agent) => {
              const usage = usageByAgent.get(agent.id) || [];
              return (
                <Card key={agent.id} role="article" className="flex min-w-0 flex-col overflow-hidden">
                  <CardHeader className="space-y-4 p-5">
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3"><span className="shrink-0 rounded-lg bg-primary/10 p-2 text-primary"><Bot className="h-5 w-5" /></span><div className="min-w-0"><CardTitle className="break-all font-mono text-lg">{agent.id}</CardTitle><Badge variant="outline" className="mt-2 max-w-full break-words">{agent.role}</Badge></div></div>
                      <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto"><button type="button" aria-label={`Edit agent ${agent.id}`} onClick={() => startEdit(agent)} disabled={Boolean(deletingId)} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Pencil className="h-3.5 w-3.5" /> Edit</button><button type="button" aria-label={`Delete agent ${agent.id}`} onClick={() => void handleDelete(agent.id)} disabled={Boolean(deletingId)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /> {deletingId === agent.id ? 'Deleting…' : 'Delete'}</button></div>
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">{agent.objective}</p>
                  </CardHeader>
                  <CardContent className="mt-auto space-y-5 border-t border-border/60 p-5">
                    <div className="grid gap-3 text-sm sm:grid-cols-2">
                      <div className="rounded-lg bg-muted/30 p-3"><p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><BrainCircuit className="h-3.5 w-3.5" /> Model</p><p className="mt-2 break-all font-medium">{agent.model || 'Default'}</p>{agent.thinking && <p className="mt-1 text-xs text-muted-foreground">Thinking: {agent.thinking}</p>}</div>
                      <div className="rounded-lg bg-muted/30 p-3"><p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><TerminalSquare className="h-3.5 w-3.5" /> Runtime</p><p className="mt-2 break-all font-medium">{agent.runtime || 'Default'}</p>{agent.runtimeCommand && <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{agent.runtimeCommand}</p>}</div>
                    </div>
                    <div><p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><FileOutput className="h-3.5 w-3.5" /> Outputs</p><div className="mt-2 flex flex-wrap gap-1.5">{agent.outputs.length ? agent.outputs.map((output) => <Badge key={output} variant="secondary" className="break-all font-mono font-medium">{output}</Badge>) : <span className="text-sm text-muted-foreground">No outputs configured.</span>}</div></div>
                    <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workflow usage</p>{workflowUsageUnavailable ? <p className="mt-2 text-sm text-muted-foreground">Usage unavailable.</p> : usage.length ? <div className="mt-2 flex flex-wrap gap-2">{usage.map((workflow) => <Badge key={workflow.id} variant="outline" className="max-w-full break-words">{workflow.name} <span className="ml-1 font-mono font-normal text-muted-foreground">({workflow.id})</span></Badge>)}</div> : <p className="mt-2 text-sm text-muted-foreground">Not referenced by a workflow.</p>}</div>
                  </CardContent>
                </Card>
              );
            })}
          </section>
        ) : agents.length > 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center"><Search className="mx-auto h-8 w-8 text-muted-foreground/50" /><h2 className="mt-3 font-semibold">No agents match your search</h2><p className="mt-1 text-sm text-muted-foreground">Try another term or reset the current search.</p><button type="button" onClick={() => setQuery('')} className="mt-4 text-sm font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Reset search</button></div>
        ) : (
          <div className="rounded-xl border border-dashed border-border p-10 text-center"><Bot className="mx-auto h-9 w-9 text-primary/50" /><h2 className="mt-3 text-lg font-semibold">No agents configured</h2><p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Create an agent to make a reusable capability available to workflows.</p>{!isEditing && <button type="button" onClick={startNew} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Plus className="h-4 w-4" /> Create Agent</button>}</div>
        )}
      </div>
    </div>
  );
}
