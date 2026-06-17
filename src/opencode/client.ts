import type { OpencodeDiff, OpencodeMessage, OpencodeSession, OpencodeStatus } from "../types.js";

export type OpencodeClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
};

export type SendMessageInput = {
  sessionId: string;
  text: string;
  providerID?: string;
  modelID?: string;
  agent?: string;
  system?: string;
  noReply?: boolean;
  tools?: Record<string, boolean>;
  async?: boolean;
};

export class OpencodeClient {
  private readonly baseUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpencodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.username = options.username;
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get url(): string {
    return this.baseUrl;
  }

  private headers(extra?: HeadersInit): HeadersInit {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(extra as Record<string, string> | undefined)
    };
    if (this.password) {
      const user = this.username ?? "opencode";
      const token = Buffer.from(`${user}:${this.password}`).toString("base64");
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`opencode ${init.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    return await this.request<{ healthy: boolean; version?: string }>("/global/health");
  }

  async listSessions(): Promise<OpencodeSession[]> {
    return await this.request<OpencodeSession[]>("/session");
  }

  async createSession(title?: string, parentID?: string): Promise<OpencodeSession> {
    return await this.request<OpencodeSession>("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, parentID })
    });
  }

  async getSession(sessionId: string): Promise<OpencodeSession> {
    return await this.request<OpencodeSession>(`/session/${encodeURIComponent(sessionId)}`);
  }

  async getSessionStatus(): Promise<Record<string, OpencodeStatus>> {
    return await this.request<Record<string, OpencodeStatus>>("/session/status");
  }

  async abortSession(sessionId: string): Promise<boolean> {
    return await this.request<boolean>(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
  }

  async getTodo(sessionId: string): Promise<unknown[]> {
    return await this.request<unknown[]>(`/session/${encodeURIComponent(sessionId)}/todo`);
  }

  async getMessages(sessionId: string, limit?: number): Promise<OpencodeMessage[]> {
    const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return await this.request<OpencodeMessage[]>(`/session/${encodeURIComponent(sessionId)}/message${query}`);
  }

  async sendMessage(input: SendMessageInput): Promise<OpencodeMessage | undefined> {
    const body = this.messageBody(input);
    const path = input.async ? `/session/${encodeURIComponent(input.sessionId)}/prompt_async` : `/session/${encodeURIComponent(input.sessionId)}/message`;
    return await this.request<OpencodeMessage | undefined>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async runCommand(sessionId: string, command: string, args?: string, agent?: string, modelID?: string): Promise<OpencodeMessage> {
    return await this.request<OpencodeMessage>(`/session/${encodeURIComponent(sessionId)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, arguments: args ?? "", agent, model: modelID ? { modelID } : undefined })
    });
  }

  async getDiff(sessionId: string, messageID?: string): Promise<OpencodeDiff[]> {
    const query = messageID ? `?messageID=${encodeURIComponent(messageID)}` : "";
    return await this.request<OpencodeDiff[]>(`/session/${encodeURIComponent(sessionId)}/diff${query}`);
  }

  async respondPermission(sessionId: string, permissionId: string, response: "allow" | "deny" | "once" | "always", remember = false): Promise<boolean> {
    return await this.request<boolean>(`/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response, remember })
    });
  }

  async readFile(path: string): Promise<unknown> {
    return await this.request<unknown>(`/file/content?path=${encodeURIComponent(path)}`);
  }

  async findFiles(query: string, limit = 50, directory?: string): Promise<string[]> {
    const params = new URLSearchParams({ query, limit: String(limit) });
    if (directory) params.set("directory", directory);
    return await this.request<string[]>(`/find/file?${params.toString()}`);
  }

  async fileStatus(): Promise<unknown[]> {
    return await this.request<unknown[]>("/file/status");
  }

  async vcs(): Promise<unknown> {
    return await this.request<unknown>("/vcs");
  }

  async listAgents(): Promise<unknown[]> {
    return await this.request<unknown[]>("/agent");
  }

  async listCommands(): Promise<unknown[]> {
    return await this.request<unknown[]>("/command");
  }

  private messageBody(input: SendMessageInput): Record<string, unknown> {
    const model = input.providerID || input.modelID ? { providerID: input.providerID, modelID: input.modelID } : undefined;
    return {
      model,
      agent: input.agent,
      noReply: input.noReply,
      system: input.system,
      tools: input.tools,
      parts: [{ type: "text", text: input.text }]
    };
  }
}
