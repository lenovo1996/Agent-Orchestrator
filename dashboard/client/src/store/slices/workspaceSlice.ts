import type { StateCreator } from 'zustand';
import type { Workspace } from '@devteam-dashboard/shared';
import { socket } from '@/lib/socket';

const API_BASE = import.meta.env.VITE_API_URL || '';

export interface WorkspaceSlice {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  setWorkspaces: (workspaces: Workspace[]) => void;
  selectWorkspace: (workspaceId: string | null) => void;
  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (name: string, path: string) => Promise<boolean>;
}

export const createWorkspaceSlice: StateCreator<
  WorkspaceSlice & { setFlows: (f: any) => void; selectFlow: (id: string | null) => void },
  [],
  [],
  WorkspaceSlice
> = (set, get) => ({
  workspaces: [],
  selectedWorkspaceId: null,
  setWorkspaces: (workspaces) => set({ workspaces }),
  selectWorkspace: (workspaceId) => {
    set({ selectedWorkspaceId: workspaceId });
    // When changing workspaces, clear out selected flows
    get().selectFlow(null);
    get().setFlows({});
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    socket.emit('workspace:select', { workspaceName: ws ? ws.name : null });
  },
  fetchWorkspaces: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/workspaces`);
      if (res.ok) {
        const workspaces = await res.json();
        set({ workspaces });
      }
    } catch (err) {
      console.error('Failed to fetch workspaces', err);
    }
  },
  createWorkspace: async (name, path) => {
    try {
      const res = await fetch(`${API_BASE}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'ws_' + Date.now(), name, path }),
      });
      if (res.ok) {
        get().fetchWorkspaces();
        return true;
      }
    } catch (err) {
      console.error('Failed to create workspace', err);
    }
    return false;
  },
});
