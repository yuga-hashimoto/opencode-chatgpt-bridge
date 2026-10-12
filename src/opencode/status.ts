import type { OpencodeClient } from "./client.js";
import type { OpencodeStatus } from "../types.js";

// Current OpenCode removes idle sessions from /session/status. Absence alone
// is not completion: require a completed final assistant turn and recheck busy.
export async function resolveSessionStatus(
  client: Pick<OpencodeClient, "getMessages" | "getSessionStatus">,
  sessionId: string,
  statuses: Record<string, OpencodeStatus>
): Promise<OpencodeStatus | null> {
  if (statuses[sessionId]) return statuses[sessionId];
  const messages = await client.getMessages(sessionId, 1);
  const info = messages.at(-1)?.info;
  if (!info || info.role !== "assistant") return null;
  const time = info.time as { completed?: unknown } | undefined;
  if (typeof time?.completed !== "number") return null;
  const current = (await client.getSessionStatus())[sessionId];
  if (current) return current;
  if (info.error) return { type: "error", error: info.error };
  if (info.finish !== "stop") return null;
  return { type: "completed", source: "completed-assistant-message" };
}
