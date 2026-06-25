import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowState, FileMetadata } from '@devteam-dashboard/shared';

/**
 * Parse workflow.json from a flow directory.
 * Returns null on any error (file missing, invalid JSON, etc.) — never throws.
 */
export function readWorkflowJson(flowDir: string): WorkflowState | null {
  const filePath = path.join(flowDir, 'workflow.json');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as WorkflowState;
    // Basic validation: must have flowId and status
    if (!parsed.flowId || !parsed.status) {
      return null;
    }
    return parsed;
  } catch {
    // File doesn't exist, permission error, or invalid JSON — all handled gracefully
    return null;
  }
}

/**
 * Read markdown output file content along with metadata (size, lastModified).
 * Returns null if the file doesn't exist or can't be read.
 */
export function readOutputContent(
  filePath: string
): { content: string; metadata: FileMetadata } | null {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      content,
      metadata: {
        size: stat.size,
        lastModified: stat.mtime.toISOString(),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Recursively scan a directory for flows (scan subdirectories that may contain workspace dirs).
 * Looks for workflow.json in immediate children (flat structure) AND one level deeper
 * (workspace/flowId/workflow.json structure).
 * Returns an empty record if the directory doesn't exist or can't be read.
 */
export function listAllFlows(taskFlowsDir: string): Record<string, WorkflowState> {
  const result: Record<string, WorkflowState> = {};

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(taskFlowsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const subDir = path.join(taskFlowsDir, entry.name);
    
    // Try reading workflow.json directly (flat structure)
    const directWorkflow = readWorkflowJson(subDir);
    if (directWorkflow) {
      result[directWorkflow.flowId] = directWorkflow;
      continue;
    }

    // Otherwise, this might be a workspace directory
    let subEntries: fs.Dirent[];
    try {
      subEntries = fs.readdirSync(subDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const subEntry of subEntries) {
      if (!subEntry.isDirectory()) continue;
      const flowDir = path.join(subDir, subEntry.name);
      const workflow = readWorkflowJson(flowDir);
      if (workflow) {
        result[workflow.flowId] = workflow;
      }
    }
  }

  return result;
}
