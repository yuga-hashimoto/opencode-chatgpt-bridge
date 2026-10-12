export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type BridgeConfig = {
  host: string;
  port: number;
 autoPort: boolean;
 allowedHosts: string[];
 allowedRoots: string[];
  bridgeToken?: string;
  opencodeBaseUrl?: string;
  opencodeBin: string;
  opencodeHost: string;
  opencodePortStart: number;
  opencodeUsername: string;
  opencodePassword?: string;
  stateDir: string;
  tunnel: "none" | "cloudflare" | "tailscale";
 tailscaleBin: string;
  cloudflaredBin: string;
};

export type BridgeSession = {
  bridgeSessionId: string;
  opencodeSessionId: string;
  repoPath: string;
  baseUrl: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
};

export type OpencodeMessagePart = {
  id?: string;
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type OpencodeMessage = {
  info: Record<string, unknown>;
  parts: OpencodeMessagePart[];
};

export type OpencodeSession = Record<string, unknown> & {
  id?: string;
  title?: string;
};

export type OpencodeDiff = Record<string, unknown> & {
  path?: string;
  oldPath?: string;
  newPath?: string;
  status?: string;
  diff?: string;
  patch?: string;
};

export type OpencodeStatus =
  | { type: "idle" | "busy" | "running" | "completed" | "error" | "cancelled"; [key: string]: unknown }
  | { status: "idle" | "completed" | "error" | "cancelled" | "running" | "busy"; [key: string]: unknown }
  | Record<string, unknown>;

export function isTerminalOpencodeStatus(status: OpencodeStatus | null | undefined): boolean {
  if (!status || typeof status !== "object") return false;
  const obj = status as Record<string, unknown>;
  const type = obj.type as string | undefined;
  const statusValue = obj.status as string | undefined;

  if (type === "idle" || type === "completed" || type === "error" || type === "cancelled") return true;
  if (statusValue === "idle" || statusValue === "completed" || statusValue === "error" || statusValue === "cancelled") return true;
  return false;
}

export function isSuccessfulTerminalOpencodeStatus(status: OpencodeStatus | null | undefined): boolean {
  if (!status || typeof status !== "object") return false;
  const obj = status as Record<string, unknown>;
  const value = typeof obj.type === "string" ? obj.type : obj.status;
  return value === "idle" || value === "completed";
}

export function isBusyOpencodeStatus(status: OpencodeStatus | null | undefined): boolean {
  if (!status || typeof status !== "object") return false;
  const obj = status as Record<string, unknown>;
  const type = obj.type as string | undefined;
  const statusValue = obj.status as string | undefined;
  return type === "busy" || type === "running" || statusValue === "running" || statusValue === "busy";
}

export type ToolResult<T extends Record<string, unknown> = Record<string, unknown>> = {
  structuredContent: T;
  content: Array<{ type: "text"; text: string }>;
};
