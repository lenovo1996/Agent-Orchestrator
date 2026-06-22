import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface ExecuteStartParams {
  scriptDir: string;
  workflowId: string;
  jiraKey: string;
  customPrompt: string;
  workspaceName?: string;
  workspacePath?: string;
}

export function executeFlowStart({
  scriptDir,
  workflowId,
  jiraKey,
  customPrompt,
  workspaceName,
  workspacePath,
}: ExecuteStartParams): string {
  const orchestratorScript = path.join(scriptDir, 'orchestrator/index.js');
  const args = ['start'];

  if (workflowId) {
    args.push('--workflow', workflowId);
  }

  if (workspaceName) {
    args.push('--workspace-name', workspaceName);
  }

  if (workspacePath) {
    args.push('--workspace-dir', workspacePath);
  }

  if (jiraKey && customPrompt) {
    args.push(jiraKey, customPrompt);
  } else if (jiraKey) {
    args.push(jiraKey);
  } else {
    args.push('--prompt', customPrompt);
  }

  const output = execFileSync(
    process.execPath,
    [orchestratorScript, ...args],
    {
      cwd: scriptDir,
      encoding: 'utf8',
      timeout: 15000,
    },
  );

  const match = output.match(/Workflow started: (flow_\S+)/);
  if (!match) {
    throw new Error('Failed to parse flow ID from orchestrator output');
  }

  return match[1];
}
