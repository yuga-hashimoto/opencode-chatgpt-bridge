import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BridgeSession } from "../types.js";

type StateFile = {
  sessions: BridgeSession[];
};

export class StateStore {
  private readonly file: string;

  constructor(private readonly stateDir: string) {
    this.file = join(stateDir, "sessions.json");
  }

  async listSessions(): Promise<BridgeSession[]> {
    return (await this.read()).sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createSession(input: Omit<BridgeSession, "bridgeSessionId" | "createdAt" | "updatedAt">): Promise<BridgeSession> {
    const now = new Date().toISOString();
    const session: BridgeSession = {
      ...input,
      bridgeSessionId: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    const state = await this.read();
    state.sessions.push(session);
    await this.write(state);
    return session;
  }

  async getSession(bridgeSessionId: string): Promise<BridgeSession> {
    const session = (await this.read()).sessions.find((item) => item.bridgeSessionId === bridgeSessionId);
    if (!session) throw new Error(`Unknown bridge session: ${bridgeSessionId}`);
    return session;
  }

  async updateSession(bridgeSessionId: string, patch: Partial<Omit<BridgeSession, "bridgeSessionId" | "createdAt">>): Promise<BridgeSession> {
    const state = await this.read();
    const index = state.sessions.findIndex((item) => item.bridgeSessionId === bridgeSessionId);
    if (index < 0) throw new Error(`Unknown bridge session: ${bridgeSessionId}`);
    const existing = state.sessions[index];
    if (!existing) throw new Error(`Unknown bridge session: ${bridgeSessionId}`);
    const updated: BridgeSession = {
      bridgeSessionId: existing.bridgeSessionId,
      createdAt: existing.createdAt,
      opencodeSessionId: patch.opencodeSessionId ?? existing.opencodeSessionId,
      repoPath: patch.repoPath ?? existing.repoPath,
      baseUrl: patch.baseUrl ?? existing.baseUrl,
      title: patch.title ?? existing.title,
      updatedAt: new Date().toISOString()
    };
    state.sessions[index] = updated;
    await this.write(state);
    return updated;
  }

  private async read(): Promise<StateFile> {
    await mkdir(this.stateDir, { recursive: true });
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as StateFile;
      return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined;
      if (code === "ENOENT") return { sessions: [] };
      throw error;
    }
  }

  private async write(state: StateFile): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.file, JSON.stringify(state, null, 2) + "\n", "utf8");
  }
}
