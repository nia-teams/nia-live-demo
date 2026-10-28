/** In-memory session registry with an idle watchdog. */
import { Session } from "./session";

const WATCHDOG_TICK_MS = 5_000;
const IDLE_TIMEOUT_MS = 60_000;
const sessions = new Map<string, Session>();

export function addSession(session: Session): void { sessions.set(session.sessionId, session); }
export function getSession(sessionId: string): Session | undefined { return sessions.get(sessionId); }

export async function stopSession(sessionId: string, reason: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  console.log(`[registry] stopping ${sessionId.slice(0, 8)} (${reason}, ${sessions.size} live)`);
  await session.stop().catch(() => {});
  return true;
}

export async function stopAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopSession(id, "shutdown")));
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.lastActivityAt >= IDLE_TIMEOUT_MS) void stopSession(session.sessionId, "idle");
  }
}, WATCHDOG_TICK_MS).unref();
