import { useEffect } from 'react';
import { socket } from '../lib/socket';
import { useDashboardStore } from '../store/use-dashboard-store';

export function useSocketEvents() {
  const {
    setConnected,
    initState,
    updateFlow,
    appendLogLines,
  } = useDashboardStore();

  useEffect(() => {
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('state:init', (payload) => {
      initState(payload);
    });

    socket.on('flow:updated', ({ flowId, workflow }) => {
      updateFlow(flowId, workflow);
    });

    socket.on('log:append', ({ flowId, step, lines }) => {
      appendLogLines(flowId, step, lines);
    });

    socket.on('output:created', (_payload) => {
      // Output created notification - UI can show indicator
    });

    socket.on('output:updated', (_payload) => {
      // Output updated notification - UI will re-fetch content on demand
    });

    // Request resync on reconnect
    socket.io.on('reconnect', () => {
      socket.emit('state:resync');
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('state:init');
      socket.off('flow:updated');
      socket.off('log:append');
      socket.off('output:created');
      socket.off('output:updated');
      socket.io.off('reconnect');
    };
  }, []);
}
