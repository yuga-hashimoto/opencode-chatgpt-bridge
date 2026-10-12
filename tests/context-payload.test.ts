import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeMcpServer } from "../src/mcp/tools.js";
import type { BridgeConfig } from "../src/types.js";

/**
 * Context and payload contract for the three prompt surfaces.
 *
 * Two properties are load-bearing for IA DEV and both were measured against a
 * real git repository with a fake OpenCode client that performs a real edit, so
 * the Git verification path runs for real and byte counts are deterministic:
 *
 *   outbound: the bridge must put NOTHING on the wire beyond what the caller
 *             asked for (no profile dump, no file contents, no history replay),
 *             because every extra byte is context the model pays for.
 *
 *   inbound:  a completed task must not hand back an unbounded conversation;
 *             message count is capped by the explicit messageLimit.
 *
 * Baseline (50-message fixture): ia_dev_run_task 32750 bytes (~8188 tokens),
 * opencode_launch_task 31836 bytes (~7959), opencode_get_messages 31625 bytes
 * (~7906). The conversation dominates, so an outbound regression is the only
 * change that could silently multiply this cost.
 */

let repo: string;
function git(...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

const ASSISTANT_TEXT = [
  "I inspected the repository and found the authentication module in src/auth.",
  "The login handler hashes the password, but the refresh token path skips validation.",
  "I added a shared helper that validates both paths and returns a typed error.",
  "Updated tests cover the refresh flow, and the build passes without warnings.",
  "Summary: refresh tokens are now validated; two files changed and one test added."
].join("\n");

const USER_TEXT = "Implement token refresh validation for the auth module.";

function turn(index: number) {
  return [
    {
      info: {
        id: `msg_u${index}`, sessionID: "ses_bench", role: "user",
        time: { created: 1000 + index * 10 },
        modelID: "mimo-v2.6-flash-free", providerID: "opencode",
        path: { cwd: repo, root: repo },
        summary: { title: "Auth task", body: "Token refresh validation" },
        cost: 0,
        tokens: { input: 1200, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      },
      parts: [{ type: "text", text: USER_TEXT }]
    },
    {
      info: {
        id: `msg_a${index}`, sessionID: "ses_bench", role: "assistant",
        time: { created: 1001 + index * 10, completed: 1002 + index * 10 },
        parentID: `msg_u${index}`,
        modelID: "mimo-v2.6-flash-free", providerID: "opencode",
        mode: "build", path: { cwd: repo, root: repo },
        cost: 0,
        tokens: { input: 1200, output: 480, reasoning: 40, cache: { read: 0, write: 0 } },
        finish: "stop"
      },
      parts: [
        { type: "text", text: ASSISTANT_TEXT },
        { type: "tool", tool: "readFile", state: { status: "completed", input: { path: "src/auth/login.ts" } } }
      ]
    }
  ];
}

const MESSAGES = Array.from({ length: 25 }, (_unused, index) => turn(index)).flat();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "ia-bench-"));
  git("init", "-b", "feature");
  git("config", "user.name", "Bench");
  git("config", "user.email", "bench@example.invalid");
  await writeFile(join(repo, ".ia-dev.yml"), [
    'version: "2.1"',
    'profile: "code-change"',
    'goal: "Payload benchmark fixture profile for reproducible byte counts"',
    "paths:",
    '  context_paths: ["**/*"]',
    '  write_paths: ["**/*"]',
    "models:",
    '  author: "mimo-v2.6-flash-free"',
    '  reviewer: "space-bunny-free"',
    ""
  ].join("\n"));
  await writeFile(join(repo, "login.ts"), "original\n");
  git("add", ".");
  git("commit", "-m", "fixture");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** The fake OpenCode performs a real edit, so Git verification succeeds. */
function buildServer() {
  const client = {
    health: vi.fn().mockResolvedValue({ healthy: true, version: "1.0.0" }),
    createSession: vi.fn().mockResolvedValue({ id: "ses_bench", title: "Auth task" }),
    getSessionStatus: vi.fn().mockResolvedValue({ ses_bench: { status: "idle" } }),
    // A real filesystem edit: this is what makes the physical Git check pass.
    sendMessage: vi.fn(async () => writeFile(join(repo, "auth.ts"), "export const refresh = 1;\n")),
    // The fake honours the limit the way a server would, so the bound is
    // exercised on a realistic payload rather than an always-full one.
    getMessages: vi.fn(async (_id: string, limit?: number) => (limit === undefined ? MESSAGES : MESSAGES.slice(-limit))),
    getDiff: vi.fn(async () => [{ path: "auth.ts", added: 1, removed: 0, content: "+export const refresh = 1;" }]),
    listAgents: vi.fn().mockResolvedValue([]),
    listCommands: vi.fn().mockResolvedValue([]),
    listProviders: vi.fn().mockResolvedValue({
      connected: ["opencode"],
      all: [{
        id: "opencode", name: "opencode", env: [],
        models: Object.fromEntries(
          ["mimo-v2.6-flash-free", "space-bunny-free"].map(id => [
            id,
            { id, name: id, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, limit: { context: 200000, output: 8192 } }
          ])
        )
      }],
      default: {}
    }),
    getProviderAuthMethods: vi.fn().mockResolvedValue({}),
    getConfigProviders: vi.fn().mockResolvedValue({}),
    abortSession: vi.fn().mockResolvedValue(true),
    respondPermission: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue({ content: "test" }),
    findFiles: vi.fn().mockResolvedValue(["test.ts"]),
    fileStatus: vi.fn().mockResolvedValue([]),
    vcs: vi.fn().mockResolvedValue({}),
    getSession: vi.fn(async (sessionId: string) => ({ id: sessionId, directory: repo }))
  };
  const processManager = {
    ensure: vi.fn().mockResolvedValue({ repoPath: repo, baseUrl: "http://127.0.0.1:4096", username: "opencode", password: "p", startedAt: "now" }),
    clientFor: vi.fn().mockReturnValue(client),
    stop: vi.fn().mockResolvedValue({ stopped: [] }),
    list: vi.fn().mockReturnValue([])
  };
  const session = {
    bridgeSessionId: "bridge_bench",
    opencodeSessionId: "ses_bench",
    repoPath: repo,
    baseUrl: "http://127.0.0.1:4096",
    title: "Auth task",
    createdAt: "now",
    updatedAt: "now"
  };
  const state = {
    createSession: vi.fn().mockResolvedValue(session),
    getSession: vi.fn().mockResolvedValue(session),
    updateSession: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...session, ...patch })),
    listSessions: vi.fn().mockResolvedValue([session])
  };
  const config: BridgeConfig = {
    host: "127.0.0.1", port: 8787, autoPort: true,
    allowedHosts: ["127.0.0.1"], allowedRoots: [tmpdir()],
    opencodeBin: "opencode", opencodeHost: "127.0.0.1", opencodePortStart: 4096,
    opencodeUsername: "opencode", stateDir: join(tmpdir(), "ia-bench-state"),
    tunnel: "none", tailscaleBin: "tailscale", cloudflaredBin: "cloudflared"
  };
  const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });
  return { server, client };
}

function measure(structured: unknown): { bytes: number; tokens: number } {
  const bytes = Buffer.byteLength(JSON.stringify(structured), "utf8");
  return { bytes, tokens: Math.round(bytes / 4) };
}

/** Bytes the wire payload would carry, as OpenCode receives it. */
function outboundBytes(body: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

/**
 * The prompt tools hand a plain argument to the client; the client is what
 * turns it into the wire body (messageBody), and that mapping is covered in
 * tests/opencode-client.test.ts. Here we assert the bridge itself adds nothing
 * to what the caller asked for.
 */
function assertCallerOnly(arg: Record<string, any>, expectedText: string, extraKeys: string[] = []) {
  expect(arg.text).toBe(expectedText);
  const keys = Object.keys(arg).filter(key => arg[key] !== undefined).sort();
  expect(keys).toEqual(["async", "modelID", "providerID", "sessionId", "text", ...extraKeys].sort());
}

const PROFILE_TEXT_PATTERNS = [
  /context_paths/, /write_paths/, /protected_paths/, /sensitive_paths/,
  /max_context_tokens/, /max_attempts/
];

describe("outbound context contract", () => {
  it.each(["ia_dev_run_task", "opencode_launch_task"])(
    "%s sends only the caller's prompt, never the profile or the repo",
    async toolName => {
      const { server, client } = buildServer();
      const tool = (server as any)._registeredTools[toolName];
      const result = await tool.handler(tool.inputSchema.parse({
        repoPath: repo, prompt: USER_TEXT, requireClean: false, allowMain: true,
        timeoutMs: 10_000, pollIntervalMs: 500, includeMessages: false, messageLimit: 50
      }));
      const content = result.structuredContent as Record<string, any>;
      const accepted = toolName === "ia_dev_run_task" ? content.success : content.error === undefined;
      expect(accepted).toBe(true);

      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      const arg = client.sendMessage.mock.calls[0]![0] as Record<string, any>;
      assertCallerOnly(arg, USER_TEXT);
      // No hidden context: no profile dump and no repo content reached the
      // client, so the prompt carries nothing but what was asked for.
      const serialized = JSON.stringify(arg);
      for (const pattern of PROFILE_TEXT_PATTERNS) {
        expect(serialized).not.toMatch(pattern);
      }
      expect(serialized).not.toContain(repo);
      expect(outboundBytes(arg)).toBeLessThan(600);
    }
  );

  it("opencode_send_message forwards caller text and nothing else", async () => {
    const { server, client } = buildServer();
    const tool = (server as any)._registeredTools.opencode_send_message;
    const result = await tool.handler(tool.inputSchema.parse({
      bridgeSessionId: "bridge_bench", text: USER_TEXT, async: true
    }));
    expect((result.structuredContent as any).ok).toBe(true);
    const arg = client.sendMessage.mock.calls[0]![0] as Record<string, any>;
    assertCallerOnly(arg, USER_TEXT);
    expect(arg.async).toBe(true);
  });
});

describe("inbound payload contract", () => {
  it("a completed task returns at most messageLimit messages", async () => {
    const { server } = buildServer();
    const tool = (server as any)._registeredTools.ia_dev_run_task;
    const result = await tool.handler(tool.inputSchema.parse({
      repoPath: repo, prompt: USER_TEXT, requireClean: false, allowMain: true,
      timeoutMs: 10_000, pollIntervalMs: 500, includeMessages: true, messageLimit: 5
    }));
    const content = result.structuredContent as Record<string, any>;
    expect(content.success).toBe(true);
    expect(content.messages.length).toBeLessThanOrEqual(5);
  });

  it("keeps the baseline payload bounded", async () => {
    const { server } = buildServer();
    const tool = (server as any)._registeredTools.ia_dev_run_task;
    const result = await tool.handler(tool.inputSchema.parse({
      repoPath: repo, prompt: USER_TEXT, requireClean: false, allowMain: true,
      timeoutMs: 10_000, pollIntervalMs: 500, includeMessages: true, messageLimit: 50
    }));
    const { bytes, tokens } = measure(result.structuredContent);
    console.log(`[benchmark] ia_dev_run_task includeMessages=true => ${bytes} bytes (~${tokens} tokens)`);
    // The fixture conversation is the floor; a jump means the bridge started
    // returning something it did not return before.
    expect(bytes).toBeLessThan(80_000);
  });

  it("does not report a second session server for the same repo", async () => {
    const { server, client } = buildServer();
    const tool = (server as any)._registeredTools.ia_dev_run_task;
    await tool.handler(tool.inputSchema.parse({
      repoPath: repo, prompt: USER_TEXT, requireClean: false, allowMain: true,
      timeoutMs: 10_000, pollIntervalMs: 500, includeMessages: false, messageLimit: 50
    }));
    expect(client.getSessionStatus).toHaveBeenCalled();
    expect(client.createSession).toHaveBeenCalledTimes(1);
  });
});
