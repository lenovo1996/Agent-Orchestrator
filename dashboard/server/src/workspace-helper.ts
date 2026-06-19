import { db } from './db.js';
import path from 'node:path';

export async function getWorkspacePath(workspaceId: string | undefined): Promise<string | null> {
  if (!workspaceId) return null;

  return new Promise((resolve, reject) => {
    db.get('SELECT path FROM workspaces WHERE id = ?', [workspaceId], (err, row: any) => {
      if (err) return reject(err);
      if (row && row.path) {
        resolve(row.path);
      } else {
        resolve(null);
      }
    });
  });
}

export async function getTaskFlowsDir(workspaceId: string | undefined, defaultTaskFlowsDir: string): Promise<string> {
  if (!workspaceId) return defaultTaskFlowsDir;

  const workspacePath = await getWorkspacePath(workspaceId);
  if (workspacePath) {
    return path.join(workspacePath, 'task-flows');
  }

  return defaultTaskFlowsDir;
}
