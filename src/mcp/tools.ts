import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { BridgeConfig, JsonValue } from "../types.js";
import { listProjects, validateRepoPath } from "../security/paths.js";
import { OpencodeProcessManager } from "../opencode/process.js";
import { StateStore } from "../state/store.js";
import { safeTool } from "./results.js";

type RegisterContext = {
  config: BridgeConfig;
  processManager: OpencodeProcessManager;
  state: StateStore;
};

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function createBridgeMcpServer(ctx: RegisterContext): McpServer {
  const server = new McpServer(
    { name: "opencode-chatgpt-bridge", version: "0.1.0" },
    {
      instructions:
        "Use this server to control local opencode sessions. Always validate a repo with list_projects or create_session first. Prefer async messages for long work, then poll get_session_status/get_messages and review get_diff before claiming changes are complete."
    }
  );

  server.registerTool(
    "bridge_health",
    {
      title: "Bridge health",
      description: "Check the bridge configuration and managed opencode processes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () =>
      safeTool(async () => ({
        ok: true,
        allowedRoots: ctx.config.allowedRoots,
        opencodeBaseUrl: ctx.config.opencodeBaseUrl ?? null,
        managedProcesses: json(ctx.processManager.list()),
        tokenAuthEnabled: Boolean(ctx.config.bridgeToken)
      }))
  );

  server.registerTool(
    "list_projects",
    {
      title: "List local projects",
      description: "List Git repositories under the configured allowed roots.",
      inputSchema: { depth: z.number().int().min(0).max(5).default(2) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ depth }) => safeTool(async () => ({ projects: json(await listProjects(ctx.config.allowedRoots, depth)) }))
  );

  server.registerTool(
    "opencode_start",
    {
      title: "Start opencode server",
      description: "Start or reuse a local opencode server for a repo path within the allowed roots.",
      inputSchema: { repoPath: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ repoPath }) =>
      safeTool(async () => {
        const validated = await validateRepoPath(repoPath, ctx.config.allowedRoots);
        const managed = await ctx.processManager.ensure(validated);
        const client = ctx.processManager.clientFor(managed);
        return { ok: true, repoPath: validated, baseUrl: managed.baseUrl, health: json(await client.health()) };
      })
  );

  server.registerTool(
    "opencode_stop",
    {
      title: "Stop opencode server",
      description: "Stop managed opencode servers spawned by the bridge. Omitting repoPath stops all managed servers.",
      inputSchema: { repoPath: z.string().optional() },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ repoPath }) =>
      safeTool(async () => {
        const validated = repoPath ? await validateRepoPath(repoPath, ctx.config.allowedRoots) : undefined;
        return { ok: true, ...(await ctx.processManager.stop(validated)) };
      })
  );

  server.registerTool(
    "opencode_create_session",
    {
      title: "Create opencode session",
      description: "Create an opencode session for a repo. Returns a bridgeSessionId used by other tools.",
      inputSchema: {
        repoPath: z.string().min(1),
        title: z.string().optional(),
        parentID: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ repoPath, title, parentID }) =>
      safeTool(async () => {
        const validated = await validateRepoPath(repoPath, ctx.config.allowedRoots);
        const managed = await ctx.processManager.ensure(validated);
        const client = ctx.processManager.clientFor(managed);
        const session = await client.createSession(title, parentID);
        const opencodeSessionId = String(session.id ?? session.ID ?? session.sessionID ?? "");
        if (!opencodeSessionId) throw new Error(`opencode returned a session without an id: ${JSON.stringify(session)}`);
        const bridge = await ctx.state.createSession({
          opencodeSessionId,
          repoPath: validated,
          baseUrl: managed.baseUrl,
          title
        });
        return { ok: true, bridgeSession: json(bridge), opencodeSession: json(session) };
      })
  );

  server.registerTool(
    "opencode_list_sessions",
    {
      title: "List bridge sessions",
      description: "List bridge sessions previously created through this MCP server.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => safeTool(async () => ({ sessions: json(await ctx.state.listSessions()) }))
  );

  server.registerTool(
    "opencode_get_session_status",
    {
      title: "Get opencode session status",
      description: "Get status for an opencode session or all sessions in that repo.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const statuses = await client.getSessionStatus();
        return {
          bridgeSession: json(bridge),
          opencodeStatus: json(statuses[bridge.opencodeSessionId] ?? null),
          allStatuses: json(statuses)
        };
      })
  );

  server.registerTool(
    "opencode_send_message",
    {
      title: "Send opencode message",
      description: "Send a prompt to an opencode session. Use async=true for long-running coding tasks.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        text: z.string().min(1),
        async: z.boolean().default(true),
        providerID: z.string().optional(),
        modelID: z.string().optional(),
        agent: z.string().optional(),
        system: z.string().optional(),
        noReply: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async (input) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(input.bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const response = await client.sendMessage({
          sessionId: bridge.opencodeSessionId,
          text: input.text,
          async: input.async,
          providerID: input.providerID,
          modelID: input.modelID,
          agent: input.agent,
          system: input.system,
          noReply: input.noReply
        });
        await ctx.state.updateSession(input.bridgeSessionId, {});
        return { ok: true, async: input.async, response: json(response ?? null) };
      })
  );

  server.registerTool(
    "opencode_get_messages",
    {
      title: "Get opencode messages",
      description: "Fetch messages from a bridge session.",
      inputSchema: { bridgeSessionId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, limit }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { bridgeSession: json(bridge), messages: json(await client.getMessages(bridge.opencodeSessionId, limit)) };
      })
  );

  server.registerTool(
    "opencode_get_diff",
    {
      title: "Get opencode diff",
      description: "Fetch file diffs for a bridge session. Call this before summarizing completed code work.",
      inputSchema: { bridgeSessionId: z.string().min(1), messageID: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, messageID }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { bridgeSession: json(bridge), diff: json(await client.getDiff(bridge.opencodeSessionId, messageID)) };
      })
  );

  server.registerTool(
    "opencode_abort",
    {
      title: "Abort opencode session",
      description: "Abort a running opencode session.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { ok: await client.abortSession(bridge.opencodeSessionId) };
      })
  );

  server.registerTool(
    "opencode_respond_permission",
    {
      title: "Respond to opencode permission",
      description: "Allow or deny an opencode permission request surfaced in the session messages/status.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        permissionId: z.string().min(1),
        response: z.enum(["allow", "deny", "once", "always"]),
        remember: z.boolean().default(false)
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ bridgeSessionId, permissionId, response, remember }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { ok: await client.respondPermission(bridge.opencodeSessionId, permissionId, response, remember) };
      })
  );

  server.registerTool(
    "opencode_read_file",
    {
      title: "Read project file through opencode",
      description: "Read a file using opencode's server API.",
      inputSchema: { bridgeSessionId: z.string().min(1), path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, path }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { file: json(await client.readFile(path)) };
      })
  );

  server.registerTool(
    "opencode_find_files",
    {
      title: "Find project files through opencode",
      description: "Fuzzy find files in the current opencode project.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
        directory: z.string().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, query, limit, directory }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { files: json(await client.findFiles(query, limit, directory)) };
      })
  );

  server.registerTool(
    "opencode_vcs_status",
    {
      title: "Get VCS status",
      description: "Get opencode VCS and tracked file status for a bridge session.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { vcs: json(await client.vcs()), files: json(await client.fileStatus()) };
      })
  );

  server.registerTool(
    "opencode_capabilities",
    {
      title: "List opencode agents and commands",
      description: "List agents and slash commands available in opencode for a bridge session.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { agents: json(await client.listAgents()), commands: json(await client.listCommands()) };
      })
  );

  return server;
}
