import type { BridgeConfig } from "./types.js";
import { maskToken } from "./config/env.js";
import type { OpencodeCliStatus } from "./opencode/setup.js";
import { getOpencodeSetupText } from "./opencode/setup.js";

export type SetupGuideInput = {
  config: BridgeConfig;
  localUrl: string;
  publicUrl?: string;
  opencodeStatus?: OpencodeCliStatus;
};

const CHATGPT_HOME_URL = "https://chatgpt.com";
const CHATGPT_CONNECTORS_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors";
const OPENAI_CONNECT_DOCS_URL = "https://developers.openai.com/apps-sdk/deploy/connect-chatgpt";
const OPENCODE_SERVER_DOCS_URL = "https://opencode.ai/docs/server/";

function withTokenInPath(url: string, token?: string): string | undefined {
  if (!token) return undefined;
  return `${url}/${encodeURIComponent(token)}`;
}

function withTokenQuery(url: string, token?: string): string | undefined {
  if (!token) return undefined;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export function getSetupGuide({ config, localUrl, publicUrl, opencodeStatus }: SetupGuideInput): string {
  const connectorUrl = publicUrl ? `${publicUrl}/mcp` : `${localUrl}/mcp`;
  const connectorUrlWithPathToken = withTokenInPath(connectorUrl, config.bridgeToken);
  const connectorUrlWithQueryToken = withTokenQuery(connectorUrl, config.bridgeToken);
  const accessMode = publicUrl
    ? "READY: use the public HTTPS MCP endpoint below in ChatGPT."
    : "LOCAL ONLY: ChatGPT needs an HTTPS URL. Start with OPENCODE_BRIDGE_TUNNEL=cloudflare or use ngrok/Tailscale Funnel.";
  const tokenLine = config.bridgeToken
    ? `Bearer token: ${maskToken(config.bridgeToken)}\n   Header auth: Authorization: Bearer <your OPENCODE_BRIDGE_TOKEN>\n   Path auth URL: ${connectorUrlWithPathToken}\n   Query auth fallback: ${connectorUrlWithQueryToken}`
    : "Bearer token: NOT SET\n   Set OPENCODE_BRIDGE_TOKEN before exposing this bridge outside localhost.";
  const opencodeLines = opencodeStatus ? getOpencodeSetupText(opencodeStatus, config) : [];

  return [
    "",
    "╭──────────────────────────────────────────────────────────╮",
    "│ opencode-chatgpt-bridge setup                              │",
    "╰───────────────────────────────────────────────────────────╯",
    "",
    accessMode,
    "",
    "1) Local bridge",
    `   Health: ${localUrl}/health`,
    `   Local MCP: ${localUrl}/mcp`,
    publicUrl ? `   Public MCP: ${connectorUrl}` : "   Public MCP: not available yet",
    `   Allowed roots: ${config.allowedRoots.join(", ")}`,
    "",
    "2) ChatGPT connector settings",
    `   Open ChatGPT: ${CHATGPT_HOME_URL}`,
    `   Direct settings link: ${CHATGPT_CONNECTORS_SETTINGS_URL}`,
    "   Manual path: Settings -> Apps & Connectors -> Advanced settings -> enable Developer mode,",
    "                then Settings -> Connectors -> Create",
    "",
    "3) Create connector with these values",
    "   Connector name: opencode local bridge",
    "   Description: Control local opencode sessions, inspect diffs, and manage local coding tasks.",
    `   Connector URL: ${connectorUrlWithPathToken ?? connectorUrl}`,
    config.bridgeToken ? `   Plain MCP URL: ${connectorUrl}` : undefined,
    `   ${tokenLine}`,
    "",
    "4) Suggested first ChatGPT prompt after connecting",
    "   Use opencode local bridge. First call bridge_health and list_projects.",
    "   Then create a session for <repo path>, ask opencode to make the requested change,",
    "   poll status, and show opencode_get_diff before claiming completion.",
    "",
    "5) Mobile use",
    "   Link the connector once from ChatGPT Web. After that, it should appear in ChatGPT mobile tools.",
    "",
    ...opencodeLines,
    opencodeLines.length ? "" : undefined,
    "Docs:",
    `   ${OPENAI_CONNECT_DOCS_URL}`,
    `   ${OPENCODE_SERVER_DOCS_URL}`,
    "",
    "Security reminder:",
    "   Keep allowed roots narrow. Review opencode_get_diff before committing or pushing changes.",
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
