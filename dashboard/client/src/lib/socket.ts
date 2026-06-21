import { io, Socket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
} from "@devteam-dashboard/shared";

// Socket.IO connection URL:
// - In dev mode: undefined = connect to same origin, Vite proxy forwards /socket.io to backend
// - When VITE_SOCKET_URL is set: use explicit URL (e.g., production with separate backend)
const SOCKET_URL: string | undefined =
  import.meta.env.VITE_SOCKET_URL || undefined;

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  SOCKET_URL,
  {
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    reconnectionAttempts: Infinity,
    // Use websocket transport first, fall back to polling
    transports: ["websocket", "polling"],
  },
);

// Debug: log connection events in development
if (import.meta.env.DEV) {
  socket.on("connect", () => console.log("[socket] connected, id:", socket.id));
  socket.on("disconnect", (reason) =>
    console.log("[socket] disconnected:", reason),
  );
  socket.on("connect_error", (err) =>
    console.error("[socket] connect_error:", err.message),
  );
}
