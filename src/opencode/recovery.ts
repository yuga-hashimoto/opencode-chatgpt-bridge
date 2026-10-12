import { realpath } from "node:fs/promises";
import type { OpencodeClient } from "./client.js";

/** Fail closed before moving a persisted session to a restarted server. */
export async function verifyRecoveredSession(
  client: Pick<OpencodeClient, "getSession">, sessionId: string, repoPath: string
): Promise<void> {
  const session = await client.getSession(sessionId);
  if (session.id !== sessionId || typeof session.directory !== "string" ||
      await realpath(session.directory) !== await realpath(repoPath)) {
    throw Object.assign(new Error("Recovered OpenCode session identity or project does not match"),
      { code: "SESSION_PROJECT_MISMATCH" });
  }
}
