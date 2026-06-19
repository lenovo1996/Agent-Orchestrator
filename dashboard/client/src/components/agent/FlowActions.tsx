import { useState } from "react";
import { useDashboardStore } from "@/store/use-dashboard-store";
import { AGENT_STEPS, getStepDisplayName } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { AgentStep } from "@devteam-dashboard/shared";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface GitRepoStatus {
  repo: string;
  branch: string;
  files: string[];
  error?: string;
}

interface GitStatus {
  repos: GitRepoStatus[];
}

export function FlowActions() {
  const selectedFlowId = useDashboardStore((s) => s.selectedFlowId);
  const flows = useDashboardStore((s) => s.flows);
  const agents = useDashboardStore((s) => s.agents);
  const workspaces = useDashboardStore((s) => s.workspaces);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const flow = selectedFlowId ? flows[selectedFlowId] : null;

  const [retryOpen, setRetryOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Retry prompt modal state
  const [promptModalOpen, setPromptModalOpen] = useState(false);
  const [retryPromptText, setRetryPromptText] = useState("");
  const [selectedStepToRetry, setSelectedStepToRetry] =
    useState<AgentStep | null>(null);

  if (!flow) return null;

  const showMessage = (type: "success" | "error", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const handleStop = async () => {
    if (
      !confirm(
        `Stop workflow ${flow.flowId}? This will kill all running agents.`,
      )
    )
      return;

    setLoading("stop");
    try {
      const res = await fetch(`${API_BASE}/api/flows/${flow.flowId}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceName: workspaces.find(w => w.id === selectedWorkspaceId)?.name })
      });
      const data = await res.json();
      if (res.ok) {
        showMessage("success", data.message);
      } else {
        showMessage("error", data.error);
      }
    } catch (err) {
      showMessage("error", "Failed to stop workflow");
    } finally {
      setLoading(null);
    }
  };

  const openRetryPromptModal = (step: AgentStep) => {
    setSelectedStepToRetry(step);
    setRetryPromptText(flow.customPrompt || "");
    setPromptModalOpen(true);
    setRetryOpen(false);
  };

  const handleRetry = async (
    step: AgentStep,
    clearOutput: boolean,
    prompt?: string,
  ) => {
    setLoading(`retry-${step}`);
    setPromptModalOpen(false);
    setRetryOpen(false);
    try {
      const bodyPayload: any = { step, clearOutput };
      if (prompt !== undefined) {
        bodyPayload.prompt = prompt;
      }
      const res = await fetch(`${API_BASE}/api/flows/${flow.flowId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });
      const data = await res.json();
      if (res.ok) {
        showMessage("success", data.message);
      } else {
        showMessage("error", data.error);
      }
    } catch (err) {
      showMessage("error", `Failed to retry ${step}`);
    } finally {
      setLoading(null);
    }
  };

  const handleGitStatus = async () => {
    if (gitOpen) {
      setGitOpen(false);
      return;
    }
    setLoading("git");
    try {
      const res = await fetch(`${API_BASE}/api/git/status`);
      const data = await res.json();
      if (res.ok) {
        setGitStatus(data);
        setGitOpen(true);
      } else {
        showMessage("error", data.error);
      }
    } catch (err) {
      showMessage("error", "Failed to fetch git status");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-2">
      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Retry button */}
        <div className="relative">
          <button
            onClick={() => setRetryOpen(!retryOpen)}
            disabled={loading !== null}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
              "bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Retry Step
          </button>

          {/* Retry dropdown — opens UPWARD */}
          {retryOpen && (
            <div className="absolute bottom-full left-0 mb-1 z-50 w-52 rounded-xl border border-border bg-card shadow-xl p-2 space-y-0.5">
              {(flow.stepOrder || AGENT_STEPS).map((step) => (
                <button
                  key={step}
                  onClick={() => openRetryPromptModal(step)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs hover:bg-accent/50 transition-colors"
                >
                  <span className="text-foreground font-medium">
                    {getStepDisplayName(step, agents)}
                  </span>
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded-full",
                      flow.steps[step] === "done" &&
                        "bg-emerald-500/10 text-emerald-400",
                      flow.steps[step] === "running" &&
                        "bg-blue-500/10 text-blue-400",
                      flow.steps[step] === "failed" &&
                        "bg-red-500/10 text-red-400",
                      flow.steps[step] === "blocked" &&
                        "bg-purple-500/10 text-purple-400",
                      flow.steps[step] === "waiting" &&
                        "bg-gray-500/10 text-gray-400",
                    )}
                  >
                    {flow.steps[step]}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Stop button */}
        <button
          onClick={handleStop}
          disabled={loading !== null || flow.status !== "running"}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
            "bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z"
            />
          </svg>
          Stop
        </button>

        {/* Git status button */}
        <div className="relative">
          <button
            onClick={handleGitStatus}
            disabled={loading === "git"}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
              "bg-muted text-muted-foreground border border-border hover:bg-accent hover:text-foreground",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              gitOpen && "bg-accent text-foreground",
            )}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"
              />
            </svg>
            Git
          </button>

          {/* Git status panel — opens UPWARD */}
          {gitOpen && gitStatus && (
            <div className="absolute bottom-full left-0 mb-1 z-50 w-96 max-w-screen-lg rounded-xl border border-border bg-card shadow-xl p-3 space-y-3">
              {/* Total summary */}
              <div className="flex items-center justify-between pb-2 border-b border-border/50">
                <span className="text-xs font-medium text-foreground">
                  Git Status - {gitStatus.repos.length}{" "}
                  {gitStatus.repos.length === 1 ? "repository" : "repositories"}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {gitStatus.repos.reduce(
                    (sum, repo) => sum + repo.files.length,
                    0,
                  )}{" "}
                  total changes
                </span>
              </div>

              {/* Repository list */}
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {gitStatus.repos.map((repo, repoIdx) => (
                  <div
                    key={repoIdx}
                    className="rounded-lg border border-border/30 bg-muted/20 p-2.5 space-y-2"
                  >
                    {/* Repo header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold text-foreground/90">
                          {repo.repo}
                        </span>
                        {repo.error && (
                          <span className="text-[10px] text-red-400">
                            ⚠ Error
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {repo.files.length}{" "}
                        {repo.files.length === 1 ? "change" : "changes"}
                      </span>
                    </div>

                    {/* Branch info */}
                    {repo.branch && (
                      <div className="text-[11px] text-muted-foreground">
                        Branch:{" "}
                        <span className="text-blue-400 font-mono">
                          {repo.branch}
                        </span>
                      </div>
                    )}

                    {/* Error message */}
                    {repo.error && (
                      <div className="text-[10px] text-red-400/80 font-mono bg-red-500/5 rounded px-2 py-1">
                        {repo.error}
                      </div>
                    )}

                    {/* File list */}
                    {repo.files.length > 0 && (
                      <div className="max-h-32 overflow-y-auto rounded-lg bg-muted/50 p-2 space-y-0.5">
                        {repo.files.slice(0, 30).map((file, fileIdx) => (
                          <div
                            key={fileIdx}
                            className="text-[11px] font-mono text-muted-foreground truncate"
                          >
                            <span
                              className={cn(
                                "inline-block w-4 text-center mr-1.5 font-bold",
                                file.startsWith(" M") && "text-amber-400",
                                file.startsWith("M ") && "text-emerald-400",
                                file.startsWith("A ") && "text-green-400",
                                file.startsWith("??") && "text-gray-500",
                                file.startsWith(" D") && "text-red-400",
                              )}
                            >
                              {file.slice(0, 2).trim() || "?"}
                            </span>
                            {file.slice(3)}
                          </div>
                        ))}
                        {repo.files.length > 30 && (
                          <div className="text-[10px] text-muted-foreground/50 pt-1">
                            ... and {repo.files.length - 30} more
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Toast message */}
      {message && (
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-lg text-xs border animate-in fade-in slide-in-from-top-1",
            message.type === "success" &&
              "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
            message.type === "error" &&
              "bg-red-500/10 text-red-400 border-red-500/20",
          )}
        >
          {message.type === "success" ? "✓" : "✗"} {message.text}
        </div>
      )}

      {/* Retry Prompt Modal */}
      {promptModalOpen && selectedStepToRetry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-4">
            <div className="space-y-1.5">
              <h3 className="text-sm font-semibold text-foreground">
                Retry {getStepDisplayName(selectedStepToRetry, agents)}
              </h3>
              <p className="text-xs text-muted-foreground">
                You can optionally update the prompt for this workflow. The
                updated prompt will replace the current custom prompt and will
                be used for this and any subsequent steps.
              </p>
            </div>

            <textarea
              value={retryPromptText}
              onChange={(e) => setRetryPromptText(e.target.value)}
              placeholder="Enter custom prompt (optional)"
              className="w-full h-32 px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setPromptModalOpen(false)}
                className="px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  handleRetry(selectedStepToRetry, true, retryPromptText)
                }
                className="px-4 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
