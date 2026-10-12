import type { OpencodeDiff, OpencodeMessage, OpencodeSession, OpencodeStatus } from "../types.js";

export type OpencodeClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
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

export class OpencodeRequestTimeoutError extends Error {
  readonly code = "OPENCODE_REQUEST_TIMEOUT";
  constructor(method: string, path: string, timeoutMs: number) {
    super(`OpenCode ${method} ${path} timed out after ${timeoutMs}ms; submission outcome may be unknown. No automatic retry.`);
    this.name = "OpencodeRequestTimeoutError";
  }
}

/**
 * Stable, structured failure domain for a non-2xx response.
 *
 * Tool consumers receive `code` through safeTool, so the same numeric status
 * must not collapse into one generic label: an operator has to be able to tell
 * "your tunnel is down" from "the provider refused the model" without parsing
 * provider-controlled prose.
 */
export function httpErrorCode(status: number): string {
  if (status === 402) return "OPENCODE_QUOTA_EXCEEDED";
  if (status === 429) return "OPENCODE_RATE_LIMITED";
  if (status === 401 || status === 403) return "OPENCODE_AUTH_ERROR";
  if (status >= 500) return "OPENCODE_SERVER_ERROR";
  return "OPENCODE_HTTP_ERROR";
}

/**
 * The managed server could not be reached at all: DNS, connection refused, TLS,
 * or a dead tunnel. Distinct from a server that answered with an error status,
 * because the remedy is entirely different (start the server / check the tunnel)
 * and no prompt outcome can be inferred from it.
 */
export class OpencodeUnreachableError extends Error {
  readonly code = "OPENCODE_UNREACHABLE";
  constructor(baseUrl: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `Could not reach the opencode server at ${baseUrl}: ${message}. ` +
      `Is the managed server running (and, for a public URL, the tunnel up)?`
    );
    this.name = "OpencodeUnreachableError";
  }
}

/** A non-2xx response. Carries the structured status so callers never have to
 * guess from the response body, which is provider-controlled free text. */
export class OpencodeHttpError extends Error {
  readonly code: string;
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly path: string,
    readonly body: string
  ) {
    super(`opencode ${status} ${statusText} on ${path}${body ? ` - ${body}` : ""}`);
    this.name = "OpencodeHttpError";
    this.code = httpErrorCode(status);
  }
}

export class OpencodeClient {
  private readonly baseUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: OpencodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.username = options.username;
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > 2147483647) {
      throw new Error("requestTimeoutMs must be a positive integer no greater than 2147483647.");
    }
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

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new OpencodeRequestTimeoutError(init.method ?? "GET", path, timeoutMs);
        reject(error);
        controller.abort(error);
      }, timeoutMs);
    });
    const operation = async (): Promise<T> => {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: this.headers(init.headers)
        });
      } catch (error) {
        // The deadline already classified this rejection; do not relabel it as
        // unreachable when it is the abort it asked for.
        if (error instanceof OpencodeRequestTimeoutError) throw error;
        // Never answered on the wire: connection refused, DNS, TLS or a dead
        // tunnel. Say so instead of surfacing a bare fetch/ECONNREFUSED string.
        throw new OpencodeUnreachableError(this.baseUrl, error);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new OpencodeHttpError(res.status, res.statusText, path, body);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    };
    try {
      // The deadline covers headers and body, even for a custom fetch that
      // ignores AbortSignal. Aborting the HTTP request never aborts a session.
      return await Promise.race([operation(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
    }, input.async ? this.requestTimeoutMs : Math.max(this.requestTimeoutMs, 600000));
  }

  async runCommand(sessionId: string, command: string, args?: string, agent?: string, modelID?: string): Promise<OpencodeMessage> {
    return await this.request<OpencodeMessage>(`/session/${encodeURIComponent(sessionId)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, arguments: args ?? "", agent, model: modelID ? { modelID } : undefined })
    }, Math.max(this.requestTimeoutMs, 600000));
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

  async listProviders(): Promise<unknown> {
    return await this.request<unknown>("/provider");
  }

  async getProviderAuthMethods(): Promise<unknown> {
    return await this.request<unknown>("/provider/auth");
  }

  async getConfigProviders(): Promise<unknown> {
    return await this.request<unknown>("/config/providers");
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
