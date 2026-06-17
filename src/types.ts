export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type BridgeConfig = {
  host: string;
  port: number;
  allowedRoots: string[];
  bridgeToken?: string;
  opencodeBaseUrl?: string;
  opencodeBin: string;
  opencodeHost: string;
  opencodePortStart: number;
  opencodeUsername: string;
  opencodePassword?: string;
  stateDir: string;
  tunnel: "none" | "cloudflare";
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

export type OpencodeStatus = Record<string, unknown>;

export type ToolResult<T extends JsonValue = JsonValue> = {
  structuredContent: T;
  content: Array<{ type: "text"; text: string }>;
};
