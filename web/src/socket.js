import { io } from "socket.io-client";
const WS_URL = import.meta.env.VITE_WS_URL || "http://localhost:3001";

export function makeSocket(token) {
  return io(WS_URL, { auth: { token } });
}
