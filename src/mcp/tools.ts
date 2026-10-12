import { verifyRecoveredSession } from "../opencode/recovery.js";
import { resolveSessionStatus } from "../opencode/status.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { BridgeConfig, JsonValue, OpencodeStatus } from "../types.js";
import type { IADevProfile } from "../config/schema.js";
import type { GitStatus } from "../git/repository.js";
import { isTerminalOpencodeStatus, isSuccessfulTerminalOpencodeStatus } from "../types.js";
import { listProjects, validateRepoPath, validateProfileExists, isSafeRepoFilePath } from "../security/paths.js";
import { validateReadAccess, validateWriteAccess as profileValidateWriteAccess, normalizeRelPath } from "../security/profile.js";
import { validateFreeModel, detectQuotaError, isSubmissionOutcomeUnknown, validateLiveFreeModels, validateObservedFreeUsage, type FreeModel } from "../models/registry.js";
import type { OpencodeClient } from "../opencode/client.js";
import { OpencodeProcessManager } from "../opencode/process.js";
import { StateStore } from "../state/store.js";
import { safeTool } from "./results.js";
import {
  validateGitRepo,
  getGitStatus,
  captureGitSnapshot,
  getGitDiffWithStaged,
  assertClean,
  assertNotMain,
  getGitDiffIncludingUntracked,
  capturePathFingerprints,
  changedFingerprints
} from "../git/repository.js";

type RegisterContext = {
  config: BridgeConfig;
  processManager: OpencodeProcessManager;
  state: StateStore;
};

function json<T extends Record<string, unknown>>(value: T): T;
function json(value: unknown): JsonValue;
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function newlyDirtyPaths(initial: GitStatus, final: GitStatus): string[] {
  const initialPaths = new Set([...initial.modified, ...initial.staged, ...initial.untracked]);
  const finalPaths = [...final.modified, ...final.staged, ...final.untracked];
  return finalPaths.filter(filePath => !initialPaths.has(filePath));
}

/**
 * Paths a task is responsible for, decided from physical fingerprints.
 *
 * `newlyDirtyPaths` covers paths that became dirty during the run.
 * `changedFingerprints` additionally catches a path that was already dirty
 * before the run and the task edited again: its worktree hash, index entry,
 * mode or existence differs, so it is attributed to the task and validated.
 * A pre-existing change the task never touched keeps its fingerprint and is
 * never blamed on the agent. A change the task reverts to its pre-run state
 * leaves no final diff, so it is not attributed to any path: attribution
 * follows the final physical state, not every action the task took.
 */
function taskOwnedPaths(
  initialStatus: GitStatus,
  finalStatus: GitStatus,
  changedByFingerprint: readonly string[]
): string[] {
  const newlyDirty = newlyDirtyPaths(initialStatus, finalStatus);
  const finalPaths = [...new Set([...finalStatus.modified, ...finalStatus.staged, ...finalStatus.untracked])];
  return [...new Set([...newlyDirty, ...changedByFingerprint])].sort().filter(path => finalPaths.includes(path));
}

/**
 * Single free-only entry point for every tool that can put a model on the wire.
 *
 * Fails closed: an explicit override must name a registry model, and either an
 * override or the profile author must additionally be verified against the live
 * provider inventory before any prompt is submitted. When free-only cannot be
 * established the prompt is not sent.
 */
function resolveModelIdentifier(
  profile: IADevProfile | null,
  override: { providerID?: string; modelID?: string }
): FreeModel {
  if (Boolean(override.providerID) !== Boolean(override.modelID)) {
    throw new Error("providerID and modelID must be supplied together.");
  }
  return validateFreeModel(
    override.providerID && override.modelID
      ? `${override.providerID}/${override.modelID}`
      : profile!.models.author
  );
}

async function assertLiveFreeModels(client: OpencodeClient, models: FreeModel[]): Promise<void> {
  validateLiveFreeModels(await client.listProviders(), models);
}

async function resolveFreeOnlyModel(
  client: OpencodeClient,
  repoPath: string,
  override: { providerID?: string; modelID?: string }
): Promise<FreeModel> {
  const profile = override.providerID ? null : await validateProfileExists(repoPath);
  const model = resolveModelIdentifier(profile, override);
  const required = profile ? [model, validateFreeModel(profile.models.reviewer)] : [model];
  await assertLiveFreeModels(client, required);
  return model;
}

async function getSessionClient(ctx: RegisterContext, bridgeSessionId: string) {
  let bridge = await ctx.state.getSession(bridgeSessionId);
  const managed = await ctx.processManager.ensure(bridge.repoPath);
  const client = ctx.processManager.clientFor(managed);
  if (bridge.baseUrl !== managed.baseUrl) {
    await verifyRecoveredSession(client, bridge.opencodeSessionId, bridge.repoPath);
    bridge = await ctx.state.updateSession(bridgeSessionId, { baseUrl: managed.baseUrl });
  }
  return { bridge, managed, client };
}

async function getSessionClientForRepoLevel(ctx: RegisterContext, bridgeSessionId: string) {
  const bridge = await ctx.state.getSession(bridgeSessionId);
  const managed = await ctx.processManager.ensure(bridge.repoPath);
  const client = ctx.processManager.clientFor(managed);
  return { bridge, managed, client };
}

export function createBridgeMcpServer(ctx: RegisterContext): McpServer {
  const server = new McpServer(
    { name: "opencode-chatgpt-bridge", version: "0.1.0" },
    {
      instructions:
        "Use this server to control local opencode sessions. Always validate a repo with list_projects or create_session first. Prefer async messages for long work, then poll get_session_status/get_messages and review get_diff before claiming changes are complete.\n\n" +
        "IMPORTANT: For authoritative repository state verification, use repo_git_status and repo_git_diff. " +
        "The opencode_vcs_status and opencode_get_diff tools return opencode's internal view which may not match the physical filesystem. " +
        "The ia_dev_run_task tool provides end-to-end task execution with Git verification - it validates repo state, runs the task, and confirms actual Git changes."
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
      description: "Get status for an opencode session or all sessions in that repo. Fails if the session cannot be recovered on the current managed server.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const { bridge, managed, client } = await getSessionClient(ctx, bridgeSessionId);
        const statuses = await client.getSessionStatus();
        return {
          bridgeSession: json(bridge),
          opencodeStatus: json(await resolveSessionStatus(client, bridge.opencodeSessionId, statuses)),
          allStatuses: json(statuses),
          managedServer: managed.baseUrl
        };
      })
  );

  server.registerTool(
    "opencode_send_message",
    {
      title: "Send opencode message",
      description: "Send a prompt to an opencode session. Use async=true for long-running coding tasks. Fails if the session cannot be recovered on the current managed server.",
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
        const { bridge, managed, client } = await getSessionClient(ctx, input.bridgeSessionId);
        const model = await resolveFreeOnlyModel(client, bridge.repoPath, {
          providerID: input.providerID,
          modelID: input.modelID
        });
        const response = await client.sendMessage({
          sessionId: bridge.opencodeSessionId,
          text: input.text,
          async: input.async,
          providerID: model.provider,
          modelID: model.modelId,
          agent: input.agent,
          system: input.system,
          noReply: input.noReply
        });
        await ctx.state.updateSession(input.bridgeSessionId, {});
        return {
          ok: true,
          async: input.async,
          model: { providerID: model.provider, modelID: model.modelId },
          response: json(response ?? null),
          managedServer: managed.baseUrl
        };
      })
  );

  server.registerTool(
    "opencode_get_messages",
    {
      title: "Get opencode messages",
      description:
        "Fetch messages from a bridge session. Fails if the session cannot be recovered on the current managed server. `limit` uses tail semantics (most recent N). Defaults to the last 50 messages when omitted.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, limit }) =>
      safeTool(async () => {
        const { bridge, managed, client } = await getSessionClient(ctx, bridgeSessionId);
        return { bridgeSession: json(bridge), messages: json(await client.getMessages(bridge.opencodeSessionId, limit)), managedServer: managed.baseUrl };
      })
  );

  server.registerTool(
    "opencode_get_diff",
    {
      title: "Get opencode diff",
      description: "Fetch file diffs for a bridge session. Call this before summarizing completed code work. Fails if the session cannot be recovered on the current managed server.",
      inputSchema: { bridgeSessionId: z.string().min(1), messageID: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, messageID }) =>
      safeTool(async () => {
        const { bridge, managed, client } = await getSessionClient(ctx, bridgeSessionId);
        return { bridgeSession: json(bridge), diff: json(await client.getDiff(bridge.opencodeSessionId, messageID)), managedServer: managed.baseUrl };
      })
  );

  server.registerTool(
    "opencode_abort",
    {
      title: "Abort opencode session",
      description: "Abort a running opencode session. Fails if the session cannot be recovered on the current managed server.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const { bridge, managed, client } = await getSessionClient(ctx, bridgeSessionId);
        return { ok: await client.abortSession(bridge.opencodeSessionId), managedServer: managed.baseUrl };
      })
  );

  server.registerTool(
    "opencode_respond_permission",
    {
      title: "Respond to opencode permission",
      description: "Allow or deny an opencode permission request surfaced in the session messages/status. Fails if the session cannot be recovered on the current managed server.",
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
        const { bridge, managed, client } = await getSessionClient(ctx, bridgeSessionId);
        return { ok: await client.respondPermission(bridge.opencodeSessionId, permissionId, response, remember), managedServer: managed.baseUrl };
      })
  );

  server.registerTool(
    "opencode_read_file",
    {
      title: "Read project file through opencode",
      description: "Read a file using opencode's server API. This is a repo-level operation and does not require session-server matching.",
      inputSchema: { bridgeSessionId: z.string().min(1), path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, path }) =>
      safeTool(async () => {
        const { bridge, managed, client } = await getSessionClientForRepoLevel(ctx, bridgeSessionId);
        const profile = await validateProfileExists(bridge.repoPath);
        if (!validateReadAccess(profile, path)) {
          throw new Error(`Read denied by .ia-dev.yml: "${path}" is outside context_paths or matches sensitive_paths.`);
        }
        if (!await isSafeRepoFilePath(bridge.repoPath, path, "read")) {
          throw new Error(`Read denied: "${path}" contains a symlink or cannot be validated within the repository.`);
        }
        return { file: json(await client.readFile(normalizeRelPath(path))), managedServer: managed.baseUrl };
      })
  );

  server.registerTool(
    "opencode_find_files",
    {
      title: "Find project files through opencode",
      description: "Fuzzy find files in the current opencode project. This is a repo-level operation and does not require session-server matching.",
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
        const { managed, client } = await getSessionClientForRepoLevel(ctx, bridgeSessionId);
        return { files: json(await client.findFiles(query, limit, directory)), managedServer: managed.baseUrl };
      })
  );

  server.registerTool(
    "opencode_vcs_status",
    {
      title: "Get VCS status",
      description: "Get opencode VCS and tracked file status for a bridge session. This is a repo-level operation and does not require session-server matching. Note: For authoritative Git status, use repo_git_status instead.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const { managed, client } = await getSessionClientForRepoLevel(ctx, bridgeSessionId);
        return { vcs: json(await client.vcs()), files: json(await client.fileStatus()), managedServer: managed.baseUrl };
      })
  );

  server.registerTool(
    "opencode_capabilities",
    {
      title: "List opencode capabilities",
      description: "List agents, slash commands, and provider/model configuration available in opencode for a bridge session.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const [agents, commands, providers, providerAuth, configProviders] = await Promise.all([
          client.listAgents(),
          client.listCommands(),
          client.listProviders(),
          client.getProviderAuthMethods(),
          client.getConfigProviders()
        ]);
        return {
          agents: json(agents),
          commands: json(commands),
          providers: json(providers),
          providerAuth: json(providerAuth),
          configProviders: json(configProviders)
        };
      })
  );

  server.registerTool(
    "opencode_wait_for_session",
    {
      title: "Wait for opencode session completion",
      description: "Poll an opencode session until it reaches a terminal state (idle/completed/error/cancelled) or timeout. Returns final status, messages, and diff. Fails if the session cannot be recovered on the current managed server.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(600000).default(120000),
        pollIntervalMs: z.number().int().min(500).max(30000).default(2000),
        includeMessages: z.boolean().default(true),
        includeDiff: z.boolean().default(true),
        messageLimit: z.number().int().min(1).max(500).default(50)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, timeoutMs, pollIntervalMs, includeMessages, includeDiff, messageLimit }) =>
      safeTool(async () => {
        const { bridge, managed, client } = await getSessionClient(ctx, bridgeSessionId);

        const startTime = Date.now();
        let lastStatus: OpencodeStatus | null = null;
        let terminal = false;

        while (Date.now() - startTime < timeoutMs) {
          const statuses = await client.getSessionStatus();
          const status = await resolveSessionStatus(client, bridge.opencodeSessionId, statuses);
          lastStatus = status;

          if (isTerminalOpencodeStatus(status)) {
            terminal = true;
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        const baseResult = {
          bridgeSession: json(bridge),
          timedOut: !terminal,
          totalWaitMs: Date.now() - startTime,
          finalStatus: json(lastStatus),
          managedServer: managed.baseUrl
        };

        let messages: JsonValue | undefined;
        let diff: JsonValue | undefined;

        if (includeMessages && lastStatus) {
          try {
            messages = json(await client.getMessages(bridge.opencodeSessionId, messageLimit));
          } catch {
            messages = json([]);
          }
        }

        if (includeDiff && lastStatus) {
          try {
            diff = json(await client.getDiff(bridge.opencodeSessionId));
          } catch {
            diff = json([]);
          }
        }

        if (messages !== undefined && diff !== undefined) {
          return { ...baseResult, messages, diff };
        }
        if (messages !== undefined) {
          return { ...baseResult, messages };
        }
        if (diff !== undefined) {
          return { ...baseResult, diff };
        }

        return baseResult;
      })
  );

  server.registerTool(
    "opencode_launch_task",
    {
      title: "Launch structured opencode task",
      description: "Create a session, send an async prompt, wait for completion, and return final status + diff in one call. Use for reliable autonomous task execution.",
      inputSchema: {
        repoPath: z.string().min(1),
        prompt: z.string().min(1),
        title: z.string().optional(),
        timeoutMs: z.number().int().min(5000).max(600000).default(180000),
        pollIntervalMs: z.number().int().min(500).max(30000).default(2000),
        providerID: z.string().optional(),
        modelID: z.string().optional(),
        agent: z.string().optional(),
        system: z.string().optional(),
        includeMessages: z.boolean().default(true),
        messageLimit: z.number().int().min(1).max(500).default(50)
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async (input) =>
      safeTool(async () => {
        const validated = await validateRepoPath(input.repoPath, ctx.config.allowedRoots);
        const managed = await ctx.processManager.ensure(validated);
        const client = ctx.processManager.clientFor(managed);
        const model = await resolveFreeOnlyModel(client, validated, {
          providerID: input.providerID,
          modelID: input.modelID
        });

        const session = await client.createSession(input.title);
        const opencodeSessionId = String(session.id ?? session.ID ?? session.sessionID ?? "");
        if (!opencodeSessionId) throw new Error(`opencode returned a session without an id: ${JSON.stringify(session)}`);

        const bridge = await ctx.state.createSession({
          opencodeSessionId,
          repoPath: validated,
          baseUrl: managed.baseUrl,
          title: input.title
        });

        await client.sendMessage({
          sessionId: opencodeSessionId,
          text: input.prompt,
          async: true,
          providerID: model.provider,
          modelID: model.modelId,
          agent: input.agent,
          system: input.system
        });

        const startTime = Date.now();
        let lastStatus: OpencodeStatus | null = null;
        let terminal = false;

        while (Date.now() - startTime < input.timeoutMs) {
          const statuses = await client.getSessionStatus();
          const status = await resolveSessionStatus(client, opencodeSessionId, statuses);
          lastStatus = status;

          if (isTerminalOpencodeStatus(status)) {
            terminal = true;
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
        }

        const baseResult = {
          bridgeSession: json(bridge),
          opencodeSession: json(session),
          timedOut: !terminal,
          totalWaitMs: Date.now() - startTime,
          finalStatus: json(lastStatus),
          managedServer: managed.baseUrl
        };

        if (input.includeMessages && lastStatus) {
          try {
            return { ...baseResult, messages: json(await client.getMessages(opencodeSessionId, input.messageLimit)), diff: json(await client.getDiff(opencodeSessionId)) };
          } catch {
            try {
              return { ...baseResult, messages: json([]), diff: json(await client.getDiff(opencodeSessionId)) };
            } catch {
              return { ...baseResult, messages: json([]), diff: json([]) };
            }
          }
        }

        try {
          return { ...baseResult, diff: json(await client.getDiff(opencodeSessionId)) };
        } catch {
          return { ...baseResult, diff: json([]) };
        }
      })
  );

  // ChatGPT Connector creation can be stricter than raw MCP clients.
 // The current MCP SDK adds experimental task execution metadata to every
 // registerTool() descriptor. We do not use task-augmented execution, so omit
 // it from tools/list for maximum Apps SDK compatibility.
 const registeredTools = (server as unknown as { _registeredTools?: Record<string, { execution?: unknown }> })._registeredTools;
 if (registeredTools) {
 for (const tool of Object.values(registeredTools)) {
 tool.execution = undefined;
 }
 }

 server.registerTool(
    "repo_git_status",
    {
      title: "Get Git repository status (physical filesystem)",
      description: "Get authoritative Git status from the physical filesystem. This is the source of truth for repository state. Use this instead of opencode_vcs_status for verification.",
      inputSchema: { repoPath: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ repoPath }) =>
      safeTool(async () => {
        const validated = await validateRepoPath(repoPath, ctx.config.allowedRoots);
        const status = await getGitStatus(validated);
        return status;
      })
  );

  server.registerTool(
    "repo_git_diff",
    {
      title: "Get Git repository diff (physical filesystem)",
      description: "Get authoritative Git diff from the physical filesystem. This is the source of truth for repository changes. Use this instead of opencode_get_diff for verification.",
      inputSchema: { repoPath: z.string().min(1), includeUntracked: z.boolean().default(true) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ repoPath, includeUntracked }) =>
      safeTool(async () => {
        const validated = await validateRepoPath(repoPath, ctx.config.allowedRoots);
        const diff = includeUntracked
          ? await getGitDiffIncludingUntracked(validated)
          : await getGitDiffWithStaged(validated);
        return diff;
      })
  );

  server.registerTool(
    "ia_dev_run_task",
    {
      title: "Run IA DEV task with Git verification",
      description: "Execute a coding task with full Git verification. Validates repo, checks clean state, blocks main branch, runs opencode task, waits for completion, and verifies changes via physical Git. Returns success only if Git shows actual changes.",
      inputSchema: {
        repoPath: z.string().min(1),
        prompt: z.string().min(1),
        title: z.string().optional(),
        timeoutMs: z.number().int().min(5000).max(600000).default(180000),
        pollIntervalMs: z.number().int().min(500).max(30000).default(2000),
        providerID: z.string().optional(),
        modelID: z.string().optional(),
        agent: z.string().optional(),
        system: z.string().optional(),
        requireClean: z.boolean().default(true),
        allowMain: z.boolean().default(false),
        includeMessages: z.boolean().default(true),
        messageLimit: z.number().int().min(1).max(500).default(50)
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async (input) =>
      safeTool(async () => {
        const validated = await validateRepoPath(input.repoPath, ctx.config.allowedRoots);

        await validateGitRepo(validated);

        if (input.requireClean) {
          await assertClean(validated);
        }

        if (!input.allowMain) {
          await assertNotMain(validated);
        }

        const profile = await validateProfileExists(validated);

        const primaryModel = resolveModelIdentifier(profile, {
          providerID: input.providerID,
          modelID: input.modelID
        });
        const reviewerModel = validateFreeModel(profile.models.reviewer);
        if (primaryModel.provider === reviewerModel.provider && primaryModel.modelId === reviewerModel.modelId) {
          throw new Error("Author and reviewer must use different models.");
        }

        if (profile.paths.write_paths.length === 0) {
          throw new Error("Profile has empty write_paths. Define write_paths in .ia-dev.yml to allow modifications.");
        }

        const initialStatus = await getGitStatus(validated);
        const initialHead = initialStatus.head;
        const initialGitDiff = await getGitDiffIncludingUntracked(validated);
        const initialSnapshot = await captureGitSnapshot(validated, initialGitDiff, initialHead);
        // Fingerprint every path that is already dirty so a later edit by the
        // task can be told apart from work that was there beforehand.
        const initialDirtyPaths = [...new Set([
          ...initialStatus.modified,
          ...initialStatus.staged,
          ...initialStatus.untracked
        ])];
        const initialFingerprints = await capturePathFingerprints(validated, initialDirtyPaths);

        const managed = await ctx.processManager.ensure(validated);
        const client = ctx.processManager.clientFor(managed);
        await assertLiveFreeModels(client, [primaryModel, reviewerModel]);

        const session = await client.createSession(input.title);
        const opencodeSessionId = String(session.id ?? session.ID ?? session.sessionID ?? "");
        if (!opencodeSessionId) throw new Error(`opencode returned a session without an id: ${JSON.stringify(session)}`);

        const bridge = await ctx.state.createSession({
          opencodeSessionId,
          repoPath: validated,
          baseUrl: managed.baseUrl,
          title: input.title
        });

        // Submitted exactly once. The registry holds no alternative author model
        // that is not the reviewer, so a quota rejection stops the task instead
        // of silently re-running the prompt under a different model.
        try {
          await client.sendMessage({
            sessionId: opencodeSessionId, text: input.prompt, async: true,
            providerID: primaryModel.provider, modelID: primaryModel.modelId,
            agent: input.agent, system: input.system
          });
        } catch (error) {
          const quotaErr = detectQuotaError(error);
          if (quotaErr) {
            throw new Error(
              `Author model ${primaryModel.provider}/${primaryModel.modelId} was rejected with HTTP ${quotaErr.status} (${quotaErr.code}). ` +
              `No alternative free author model is registered, and the prompt was not resubmitted.`
            );
          }
          if (isSubmissionOutcomeUnknown(error)) {
            throw new Error(
              `Prompt submission outcome is unknown for ${primaryModel.provider}/${primaryModel.modelId}; it was NOT resubmitted. ` +
              `Inspect session ${opencodeSessionId} before retrying manually. Cause: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          throw error;
        }

        const startTime = Date.now();
        let lastStatus: OpencodeStatus | null = null;
        let terminal = false;
        let successfulTerminal = false;

        while (Date.now() - startTime < input.timeoutMs) {
          const statuses = await client.getSessionStatus();
          const status = await resolveSessionStatus(client, opencodeSessionId, statuses);
          lastStatus = status;

          if (isTerminalOpencodeStatus(status)) {
            terminal = true;
            successfulTerminal = isSuccessfulTerminalOpencodeStatus(status);
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
        }

        const finalGitStatus = await getGitStatus(validated);
        const finalGitDiff = await getGitDiffIncludingUntracked(validated);

        let verificationError: string | undefined;
        let gitChanged = false;
        let taskChangedPaths: string[] = [];
        try {
          const finalSnapshot = await captureGitSnapshot(validated, finalGitDiff, finalGitStatus.head);
          gitChanged = JSON.stringify(initialSnapshot) !== JSON.stringify(finalSnapshot);
          const finalDirtyPaths = [...new Set([
            ...finalGitStatus.modified,
            ...finalGitStatus.staged,
            ...finalGitStatus.untracked
          ])];
          const finalFingerprints = await capturePathFingerprints(validated, finalDirtyPaths);
          taskChangedPaths = taskOwnedPaths(
            initialStatus,
            finalGitStatus,
            changedFingerprints(initialFingerprints, finalFingerprints)
          );
        } catch (error) {
          verificationError = error instanceof Error ? error.message : String(error);
        }

        const baseResult = {
          bridgeSession: json(bridge),
          opencodeSession: json(session),
          timedOut: !terminal,
          totalWaitMs: Date.now() - startTime,
          finalStatus: json(lastStatus),
          managedServer: managed.baseUrl,
          gitVerification: {
            initialHead,
            finalHead: finalGitStatus.head,
            initialClean: initialStatus.clean,
            finalClean: finalGitStatus.clean,
            gitChanged,
            gitDiff: json(finalGitDiff),
            gitStatus: json(finalGitStatus)
          }
        };

        if (!terminal) {
          return { ...baseResult, success: false, error: "Task timed out before reaching terminal state." };
        }

        if (!successfulTerminal) {
          return { ...baseResult, success: false, error: `OpenCode terminated with status: ${JSON.stringify(lastStatus)}. Only idle/completed are considered successful.` };
        }

        if (verificationError) {
          return { ...baseResult, success: false, error: verificationError };
        }

        if (!gitChanged) {
          return { ...baseResult, success: false, error: "OpenCode completed but no Git changes detected. Task may have failed to produce changes." };
        }

        // Physical Git is the source of truth for what actually changed.
        // Paths the task owned must satisfy the profile's write policy;
        // protected/sensitive paths win over write_paths.
        const changedPaths = taskChangedPaths;
        const deniedByPolicy = changedPaths.filter(filePath => !profileValidateWriteAccess(profile, filePath));
        const policyResult = {
          changedPaths,
          deniedPaths: deniedByPolicy
        };

        if (deniedByPolicy.length > 0) {
          return {
            ...baseResult,
            success: false,
            error: `Task modified paths outside the profile write policy: ${deniedByPolicy.join(", ")}.`,
            pathPolicy: json(policyResult)
          };
        }

        // Post-hoc evidence of the model that actually ran, from the
        // providerID/modelID/cost recorded on each assistant turn.
        let observedUsage;
        try {
          const messages = await client.getMessages(opencodeSessionId, input.messageLimit);
          observedUsage = json(validateObservedFreeUsage(messages));
        } catch (error) {
          return {
            ...baseResult,
            success: false,
            pathPolicy: json(policyResult),
            error: `Could not verify that the session stayed on a free model: ${error instanceof Error ? error.message : String(error)}`
          };
        }

        const successResult = {
          ...baseResult,
          success: true,
          pathPolicy: json(policyResult),
          observedUsage
        };

        if (input.includeMessages && lastStatus) {
          try {
            return { ...successResult, messages: json(await client.getMessages(opencodeSessionId, input.messageLimit)) };
          } catch {
            return { ...successResult, messages: json([]) };
          }
        }

        return successResult;
      })
  );

  return server;
}
