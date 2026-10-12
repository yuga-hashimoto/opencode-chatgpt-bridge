import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createBridgeMcpServer } from "../src/mcp/tools.js";
import type { BridgeConfig } from "../src/types.js";
import { OpencodeProcessManager } from "../src/opencode/process.js";
import { StateStore } from "../src/state/store.js";
import { validateRepoPath, validateProfileExists, isSafeRepoFilePath } from "../src/security/paths.js";
import * as gitModule from "../src/git/repository.js";
import { OpencodeHttpError, OpencodeRequestTimeoutError } from "../src/opencode/client.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/security/paths.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    validateRepoPath: vi.fn(),
    listProjects: vi.fn(),
    validateProfileExists: vi.fn(),
    isSafeRepoFilePath: vi.fn()
  };
});

vi.mock("../src/git/repository.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    captureGitSnapshot: vi.fn(async (_path, diff, head) => ({
      head,
      diff: diff.diff,
      stagedDiff: diff.stagedDiff,
      untracked: diff.untracked,
      pathFingerprints: []
    })),
    validateGitRepo: vi.fn(),
    getGitStatus: vi.fn(),
    getGitDiffIncludingUntracked: vi.fn(),
    assertClean: vi.fn(),
    assertNotMain: vi.fn(),
    capturePathFingerprints: vi.fn(async (_repo: string, paths: string[]) =>
      paths.map(path => ({ path, worktree: null, index: null, mode: 0, absent: true }))
    ),
    // Delegate to the real implementation so fingerprint comparison is exercised.
    changedFingerprints: vi.fn(actual.changedFingerprints)
  };
});

function createMockContext(overrides: Partial<{
  config: BridgeConfig;
  processManager: Partial<OpencodeProcessManager>;
  state: Partial<StateStore>;
  gitMocks?: {
    validateGitRepo?: ReturnType<typeof vi.fn>;
    getGitStatus?: ReturnType<typeof vi.fn>;
    getGitDiffIncludingUntracked?: ReturnType<typeof vi.fn>;
    assertClean?: ReturnType<typeof vi.fn>;
    assertNotMain?: ReturnType<typeof vi.fn>;
  };
}> = {}) {
  const config: BridgeConfig = {
    host: "127.0.0.1",
    port: 8787,
    autoPort: true,
    allowedHosts: ["127.0.0.1"],
    allowedRoots: ["/tmp/test"],
    bridgeToken: "test-token",
    opencodeBin: "opencode",
    opencodeHost: "127.0.0.1",
    opencodePortStart: 4096,
    opencodeUsername: "opencode",
    stateDir: "/tmp/test-state",
    tunnel: "none",
    tailscaleBin: "tailscale",
    cloudflaredBin: "cloudflared",
    ...overrides.config
  };

  vi.mocked(isSafeRepoFilePath).mockResolvedValue(true);

  const mockClient = {
    health: vi.fn().mockResolvedValue({ healthy: true, version: "1.0.0" }),
    createSession: vi.fn().mockResolvedValue({ id: "ses_test123", title: "Test Session" }),
    getSessionStatus: vi.fn().mockResolvedValue({ ses_test123: { status: "idle" } }),
    sendMessage: vi.fn().mockResolvedValue({ info: {}, parts: [{ type: "text", text: "Response" }] }),
    getMessages: vi.fn().mockResolvedValue([{ info: { role: "assistant", providerID: "opencode", modelID: "mimo-v2.6-flash-free", cost: 0 }, parts: [{ type: "text", text: "Hello" }] }]),
    getDiff: vi.fn().mockResolvedValue([{ path: "test.ts", diff: "+ console.log('hello')" }]),
    listAgents: vi.fn().mockResolvedValue([]),
    listCommands: vi.fn().mockResolvedValue([]),
    listProviders: vi.fn().mockResolvedValue({ connected: ["opencode"], all: [{ id: "opencode", name: "opencode", env: [], models: Object.fromEntries(["mimo-v2.6-flash-free", "space-bunny-free"].map(id => [id, { id, name: id, release_date: "2026-01-01", attachment: false, reasoning: false, temperature: true, tool_call: true, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, limit: { context: 200000, output: 8192 }, options: {} }])) }], default: {} }),
    getProviderAuthMethods: vi.fn().mockResolvedValue({}),
    getConfigProviders: vi.fn().mockResolvedValue({}),
    abortSession: vi.fn().mockResolvedValue(true),
    respondPermission: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue({ content: "test" }),
    findFiles: vi.fn().mockResolvedValue(["test.ts"]),
    fileStatus: vi.fn().mockResolvedValue([]),
    vcs: vi.fn().mockResolvedValue({}),
    getSession: vi.fn(async (sessionId: string) => ({ id: sessionId, directory: "/tmp/test/repo" }))
  };

  const processManager = {
    ensure: vi.fn().mockResolvedValue({
      repoPath: "/tmp/test/repo",
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "test-password",
      startedAt: new Date().toISOString()
    }),
    clientFor: vi.fn().mockReturnValue(mockClient),
    stop: vi.fn().mockResolvedValue({ stopped: [] }),
    list: vi.fn().mockReturnValue([]),
    ...overrides.processManager
  };

  const mockSession = {
    bridgeSessionId: "bridge_test123",
    opencodeSessionId: "ses_test123",
    repoPath: "/tmp/test/repo",
    baseUrl: "http://127.0.0.1:4096",
    title: "Test Session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const state = {
    createSession: vi.fn().mockResolvedValue(mockSession),
    getSession: vi.fn().mockResolvedValue(mockSession),
    listSessions: vi.fn().mockResolvedValue([mockSession]),
    updateSession: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...mockSession, ...patch })),
    ...overrides.state
  };

  // Set up git module mocks with defaults
  gitModule.validateGitRepo.mockResolvedValue({
    repoPath: "/tmp/test/repo",
    topLevel: "/tmp/test/repo",
    branch: "feature-branch",
    head: "abc123",
    isMainBranch: false
  });
  gitModule.getGitStatus.mockResolvedValue({
    repoPath: "/tmp/test/repo",
    topLevel: "/tmp/test/repo",
    branch: "feature-branch",
    head: "abc123",
    clean: true,
    porcelain: "## feature-branch",
    untracked: [],
    modified: [],
    staged: []
  });
  gitModule.getGitDiffIncludingUntracked.mockResolvedValue({
    repoPath: "/tmp/test/repo",
    topLevel: "/tmp/test/repo",
    diff: "",
    stagedDiff: "",
    untracked: [],
    hasChanges: false
  });
  gitModule.assertClean.mockResolvedValue(undefined);
  gitModule.assertNotMain.mockResolvedValue(undefined);

  (validateProfileExists as any).mockResolvedValue({
    version: "2.1",
    profile: "code-change",
    goal: "Test profile used by MCP tool tests",
    paths: {
      context_paths: ["**/*"],
      write_paths: ["src/**/*"],
      protected_paths: [".github/**"],
      sensitive_paths: ["**/.env*"]
    },
    models: { author: "mimo-v2.6-flash-free", reviewer: "space-bunny-free" },
    limits: { max_context_tokens: 4000, max_attempts: 3, timeout_ms: 300000 },
    commands: {}
  });

  // Override with test-specific mocks if provided
  if (overrides.gitMocks) {
    if (overrides.gitMocks.validateGitRepo) gitModule.validateGitRepo.mockImplementation(overrides.gitMocks.validateGitRepo);
    if (overrides.gitMocks.getGitStatus) gitModule.getGitStatus.mockImplementation(overrides.gitMocks.getGitStatus);
    if (overrides.gitMocks.getGitDiffIncludingUntracked) gitModule.getGitDiffIncludingUntracked.mockImplementation(overrides.gitMocks.getGitDiffIncludingUntracked);
    if (overrides.gitMocks.assertClean) gitModule.assertClean.mockImplementation(overrides.gitMocks.assertClean);
    if (overrides.gitMocks.assertNotMain) gitModule.assertNotMain.mockImplementation(overrides.gitMocks.assertNotMain);
  }

  return { config, processManager, state, mockClient, mockSession };
}

function createMockContextWithMismatch(overrides: Partial<{
  config: BridgeConfig;
  processManager: Partial<OpencodeProcessManager>;
  state: Partial<StateStore>;
}> = {}) {
  const { config, processManager, state, mockClient } = createMockContext(overrides);

  const oldBaseUrl = "http://127.0.0.1:4096";
  const newBaseUrl = "http://127.0.0.1:4097";
  const projectDir = process.cwd();

  const sessionRecord = (patch: Record<string, unknown> = {}) => ({
    bridgeSessionId: "bridge_test123",
    opencodeSessionId: "ses_test123",
    repoPath: projectDir,
    baseUrl: oldBaseUrl,
    title: "Test Session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch
  });

  const oldSession = {
    ...state,
    getSession: vi.fn().mockResolvedValue(sessionRecord()),
    updateSession: vi.fn(async (_id: string, patch: Record<string, unknown>) => sessionRecord(patch))
  };

  mockClient.getSession.mockResolvedValue({ id: "ses_test123", directory: projectDir });

  const newProcessManager = {
    ...processManager,
    ensure: vi.fn().mockResolvedValue({
      repoPath: projectDir,
      baseUrl: newBaseUrl,
      username: "opencode",
      password: "test-password",
      startedAt: new Date().toISOString()
    })
  };

  return { config, processManager: newProcessManager, state: oldSession, mockClient };
}

describe("MCP Tools - wait_for_session", () => {
  it("polls until session is idle and returns final status with messages and diff", async () => {
    const { config, processManager, state, mockClient } = createMockContext();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const mockStatuses = [
      { ses_test123: { status: "running" } },
      { ses_test123: { status: "running" } },
      { ses_test123: { status: "idle" } }
    ];
    let callCount = 0;
    mockClient.getSessionStatus.mockImplementation(() => Promise.resolve(mockStatuses[callCount++] || { ses_test123: { status: "idle" } }));

    const tool = (server as any)._registeredTools?.opencode_wait_for_session;
    expect(tool).toBeDefined();

    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      timeoutMs: 10000,
      pollIntervalMs: 10,
      includeMessages: true,
      includeDiff: true,
      messageLimit: 10
    });

    expect(result.structuredContent).toBeDefined();
    const content = result.structuredContent as any;
    expect(content.timedOut).toBe(false);
    expect(content.finalStatus).toEqual({ status: "idle" });
    expect(content.messages).toBeDefined();
    expect(content.diff).toBeDefined();
    expect(mockClient.getSessionStatus).toHaveBeenCalledTimes(3);
  });

  it("times out if session does not reach terminal state", async () => {
    const { config, processManager, state, mockClient } = createMockContext();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSessionStatus.mockResolvedValue({ ses_test123: { status: "running" } });

    const tool = (server as any)._registeredTools?.opencode_wait_for_session;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      timeoutMs: 50,
      pollIntervalMs: 10,
      includeMessages: false,
      includeDiff: false
    });

    const content = result.structuredContent as any;
    expect(content.timedOut).toBe(true);
    expect(content.finalStatus).toEqual({ status: "running" });
    expect(content.messages).toBeUndefined();
    expect(content.diff).toBeUndefined();
  });

  it("handles error status as terminal", async () => {
    const { config, processManager, state, mockClient } = createMockContext();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const mockStatuses = [
      { ses_test123: { status: "running" } },
      { ses_test123: { status: "error", error: "Something failed" } }
    ];
    let callCount = 0;
    mockClient.getSessionStatus.mockImplementation(() => Promise.resolve(mockStatuses[callCount++] || { ses_test123: { status: "error" } }));

    const tool = (server as any)._registeredTools?.opencode_wait_for_session;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      timeoutMs: 10000,
      pollIntervalMs: 10
    });

    const content = result.structuredContent as any;
    expect(content.timedOut).toBe(false);
    expect(content.finalStatus).toEqual({ status: "error", error: "Something failed" });
  });
});

describe("MCP Tools - launch_task", () => {
  let allowedRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    allowedRoot = await mkdtemp(join(tmpdir(), "bridge-allowed-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    await mkdtemp(join(allowedRoot, "repo-"));
    (validateRepoPath as any).mockImplementation(async (repoPath: string, allowedRoots: string[]) => {
      const resolved = repoPath;
      const allowed = allowedRoots[0] === "/allowed/root" ? [allowedRoot] : allowedRoots;
      if (!allowed.some((root: string) => resolved.startsWith(root))) {
        throw new Error(`Repo path is outside allowed roots: ${resolved}`);
      }
      return resolved;
    });
  });

  it("creates session, sends async message, waits for completion, returns diff", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      config: { allowedRoots: [allowedRoot] }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const mockStatuses = [
      { ses_test123: { status: "running" } },
      { ses_test123: { status: "idle" } }
    ];
    let callCount = 0;
    mockClient.getSessionStatus.mockImplementation(() => Promise.resolve(mockStatuses[callCount++] || { ses_test123: { status: "idle" } }));

    const tool = (server as any)._registeredTools?.opencode_launch_task;
    expect(tool).toBeDefined();

    const result = await tool.handler({
      repoPath: join(allowedRoot, "repo-test"),
      prompt: "Create a hello world file",
      title: "Test Task",
      timeoutMs: 10000,
      pollIntervalMs: 10,
      includeMessages: true,
      messageLimit: 10
    });

    const content = result.structuredContent as any;
    expect(content.timedOut).toBe(false);
    expect(content.bridgeSession).toBeDefined();
    expect(content.opencodeSession).toBeDefined();
    expect(content.finalStatus).toEqual({ status: "idle" });
    expect(content.messages).toBeDefined();
    expect(content.diff).toBeDefined();

    expect(processManager.ensure).toHaveBeenCalled();
    expect(state.createSession).toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "ses_test123",
      text: "Create a hello world file",
      async: true
    }));
  });

  it("passes provider/model/agent options to sendMessage", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      config: { allowedRoots: [allowedRoot] }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSessionStatus.mockResolvedValue({ ses_test123: { status: "idle" } });

    const tool = (server as any)._registeredTools?.opencode_launch_task;
    await tool.handler({
      repoPath: join(allowedRoot, "repo-test"),
      prompt: "Test prompt",
      providerID: "opencode",
      modelID: "mimo-v2.6-flash-free",
      agent: "coder",
      system: "You are a helpful assistant"
    });

    expect(mockClient.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      providerID: "opencode",
      modelID: "mimo-v2.6-flash-free",
      agent: "coder",
      system: "You are a helpful assistant"
    }));
  });

  it("refuses a paid model on opencode_launch_task", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      config: { allowedRoots: [allowedRoot] }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.opencode_launch_task;
    const result = await tool.handler({
      repoPath: join(allowedRoot, "repo-test"),
      prompt: "Test prompt",
      providerID: "anthropic",
      modelID: "claude-3-haiku"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toMatch(/free-model registry/);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a half-specified model override on opencode_launch_task", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      config: { allowedRoots: [allowedRoot] }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.opencode_launch_task;
    const result = await tool.handler({
      repoPath: join(allowedRoot, "repo-test"),
      prompt: "Test prompt",
      providerID: "opencode"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toMatch(/must be supplied together/);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a paid model on opencode_send_message", async () => {
    const { config, processManager, state, mockClient } = createMockContext();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.opencode_send_message;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      text: "hello",
      providerID: "openai",
      modelID: "gpt-4o"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toMatch(/free-model registry/);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a half-specified model override on opencode_send_message", async () => {
    const { config, processManager, state, mockClient } = createMockContext();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.opencode_send_message;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      text: "hello",
      modelID: "mimo-v2.6-flash-free"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toMatch(/must be supplied together/);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("fails closed on opencode_send_message when the provider inventory is unusable", async () => {
    const { config, processManager, state, mockClient } = createMockContext();
    mockClient.listProviders.mockResolvedValue({ connected: [], all: [] });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.opencode_send_message;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      text: "hello",
      providerID: "opencode",
      modelID: "mimo-v2.6-flash-free"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toMatch(/verified zero-cost/);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it("times out and returns partial results", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      config: { allowedRoots: [allowedRoot] }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSessionStatus.mockResolvedValue({ ses_test123: { status: "running" } });

    const tool = (server as any)._registeredTools?.opencode_launch_task;
    const result = await tool.handler({
      repoPath: join(allowedRoot, "repo-test"),
      prompt: "Long running task",
      timeoutMs: 50,
      pollIntervalMs: 10
    });

    const content = result.structuredContent as any;
    expect(content.timedOut).toBe(true);
    expect(content.finalStatus).toEqual({ status: "running" });
    expect(content.diff).toBeDefined();
  });

  it("validates repo path against allowed roots", async () => {
    const { config, processManager, state } = createMockContext({
      config: { allowedRoots: ["/allowed/root"] }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.opencode_launch_task;
    const result = await tool.handler({
      repoPath: outsideRoot,
      prompt: "Test"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toContain("outside allowed roots");
  });
});

describe("MCP Tools - session server recovery", () => {
  it("recovers a session after a managed server restart when identity and project match", async () => {
    const { config, processManager, state, mockClient } = createMockContextWithMismatch();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSessionStatus.mockResolvedValue({ ses_test123: { status: "idle" } });

    const tool = (server as any)._registeredTools?.opencode_get_session_status;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123"
    });

    const content = result.structuredContent as any;
    expect(content.code).toBeUndefined();
    expect(content.managedServer).toBe("http://127.0.0.1:4097");
    expect(mockClient.getSession).toHaveBeenCalledWith("ses_test123");
    expect(state.updateSession).toHaveBeenCalledWith("bridge_test123", { baseUrl: "http://127.0.0.1:4097" });
  });

  it("sends messages to the current managed server after recovery", async () => {
    const { config, processManager, state, mockClient } = createMockContextWithMismatch();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.opencode_send_message;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      text: "Test message"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(true);
    expect(content.managedServer).toBe("http://127.0.0.1:4097");
    expect(mockClient.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_test123" }));
  });

  it("rejects recovery when the recovered session belongs to a different project", async () => {
    const { config, processManager, state, mockClient } = createMockContextWithMismatch();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSession.mockResolvedValue({ id: "ses_test123", directory: tmpdir() });

    const tool = (server as any)._registeredTools?.opencode_get_messages;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.code).toBe("SESSION_PROJECT_MISMATCH");
    expect(state.updateSession).not.toHaveBeenCalled();
  });

  it("keeps the managed server error when the session no longer exists", async () => {
    const { config, processManager, state, mockClient } = createMockContextWithMismatch();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSession.mockRejectedValue(new Error("session not found on managed server"));

    const tool = (server as any)._registeredTools?.opencode_get_diff;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toContain("session not found on managed server");
    expect(state.updateSession).not.toHaveBeenCalled();
  });

  it("allows repo-level operations (opencode_read_file) even with baseUrl mismatch", async () => {
    const { config, processManager, state, mockClient } = createMockContextWithMismatch();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.readFile.mockResolvedValue({ content: "test file" });

    const tool = (server as any)._registeredTools?.opencode_read_file;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      path: "test.txt"
    });

    const content = result.structuredContent as any;
    expect(content).toBeDefined();
    expect(content.file).toEqual({ content: "test file" });
    expect(mockClient.getSession).not.toHaveBeenCalled();
  });

  it("blocks unsafe filesystem paths before delegating a read", async () => {
    const { config, processManager, state, mockClient } = createMockContext();
    vi.mocked(isSafeRepoFilePath).mockResolvedValue(false);
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });
    const tool = (server as any)._registeredTools.opencode_read_file;
    const result = await tool.handler({ bridgeSessionId: "test", path: "src/alias.ts" });
    expect(result.structuredContent.ok).toBe(false);
    expect(mockClient.readFile).not.toHaveBeenCalled();
  });

  it("denies opencode_read_file for sensitive_paths", async () => {
    const { config, processManager, state, mockClient } = createMockContextWithMismatch();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.opencode_read_file;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      path: ".env.production"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toContain("Read denied by .ia-dev.yml");
    expect(mockClient.readFile).not.toHaveBeenCalled();
  });

  it("denies opencode_read_file for absolute paths outside the repo", async () => {
    const { config, processManager, state, mockClient } = createMockContextWithMismatch();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.opencode_read_file;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      path: "/etc/passwd"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toContain("Read denied by .ia-dev.yml");
    expect(mockClient.readFile).not.toHaveBeenCalled();
  });

  it("denies opencode_read_file for parent-directory traversal", async () => {
    const { config, processManager, state, mockClient } = createMockContextWithMismatch();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.opencode_read_file;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      path: "../outside/secret.ts"
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toContain("Read denied by .ia-dev.yml");
    expect(mockClient.readFile).not.toHaveBeenCalled();
  });

  it("allows repo-level operations (opencode_find_files) even with baseUrl mismatch", async () => {
    const { config, processManager, state, mockClient } = createMockContextWithMismatch();
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.findFiles.mockResolvedValue(["test.txt"]);

    const tool = (server as any)._registeredTools?.opencode_find_files;
    const result = await tool.handler({
      bridgeSessionId: "bridge_test123",
      query: "test"
    });

    const content = result.structuredContent as any;
    expect(content).toBeDefined();
    expect(content.files).toEqual(["test.txt"]);
    expect(mockClient.getSession).not.toHaveBeenCalled();
  });
});

describe("MCP Tools - ia_dev_run_task", () => {
  it("returns success true when requireClean default=true and Git shows real changes", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "abc123",
            clean: true,
            porcelain: "## feature-branch",
            untracked: [],
            modified: [],
            staged: []
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "def456",
            clean: false,
            porcelain: "## feature-branch\n M src/generated/newfile.txt",
            untracked: ["src/generated/newfile.txt"],
            modified: [],
            staged: []
          }),
        getGitDiffIncludingUntracked: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          diff: "diff --git a/src/generated/newfile.txt b/src/generated/newfile.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/generated/newfile.txt\n@@ -0,0 +1 @@\n+new content",
          stagedDiff: "",
          untracked: [{ path: "src/generated/newfile.txt", readable: true }],
          hasChanges: true
        }),
        validateGitRepo: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "feature-branch",
          head: "abc123",
          isMainBranch: false
        }),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockResolvedValue(undefined)
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const mockStatuses = [
      { ses_test123: { status: "running" } },
      { ses_test123: { status: "idle" } }
    ];
    let callCount = 0;
    mockClient.getSessionStatus.mockImplementation(() => Promise.resolve(mockStatuses[callCount++] || { ses_test123: { status: "idle" } }));

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    expect(tool).toBeDefined();

    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Create a test file",
      timeoutMs: 10000,
      pollIntervalMs: 10,
      includeMessages: true,
      messageLimit: 10
    });

    const content = result.structuredContent as any;
    expect(content.success).toBe(true);
    expect(content.gitVerification.gitChanged).toBe(true);
    expect(content.gitVerification.initialClean).toBe(true);
  });

  it("returns success false when OpenCode completes but Git shows no changes", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "feature-branch",
          head: "abc123",
          clean: true,
          porcelain: "## feature-branch",
          untracked: [],
          modified: [],
          staged: []
        }),
        getGitDiffIncludingUntracked: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          diff: "",
          stagedDiff: "",
          untracked: [],
          hasChanges: false
        }),
        validateGitRepo: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "feature-branch",
          head: "abc123",
          isMainBranch: false
        }),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockResolvedValue(undefined)
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSessionStatus.mockResolvedValue({ ses_test123: { status: "idle" } });

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Do nothing",
      timeoutMs: 10000,
      pollIntervalMs: 10,
      includeMessages: true,
      messageLimit: 10
    });

    const content = result.structuredContent as any;
    expect(content.success).toBe(false);
    expect(content.error).toContain("no Git changes detected");
  });

  it("returns success false when task times out", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "feature-branch",
          head: "abc123",
          clean: true,
          porcelain: "## feature-branch",
          untracked: [],
          modified: [],
          staged: []
        }),
        getGitDiffIncludingUntracked: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          diff: "",
          stagedDiff: "",
          untracked: [],
          hasChanges: false
        }),
        validateGitRepo: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "feature-branch",
          head: "abc123",
          isMainBranch: false
        }),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockResolvedValue(undefined)
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSessionStatus.mockResolvedValue({ ses_test123: { status: "running" } });

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Long running task",
      timeoutMs: 50,
      pollIntervalMs: 10
    });

    const content = result.structuredContent as any;
    expect(content.success).toBe(false);
    expect(content.timedOut).toBe(true);
    expect(content.error).toContain("timed out");
  });

  it("blocks main branch when allowMain is false (default)", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        validateGitRepo: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "main",
          head: "abc123",
          isMainBranch: true
        }),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockRejectedValue(new Error("Cannot modify protected branch 'main' in /tmp/test/repo. Create a feature branch first."))
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Test",
      allowMain: false
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toContain("protected branch");
  });

  it("allows main branch when allowMain is true", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "main",
            head: "abc123",
            clean: true,
            porcelain: "## main",
            untracked: [],
            modified: [],
            staged: []
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "main",
            head: "def456",
            clean: false,
            porcelain: "## main\n M src/generated/newfile.txt",
            untracked: ["src/generated/newfile.txt"],
            modified: [],
            staged: []
          }),
        getGitDiffIncludingUntracked: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          diff: "diff --git a/src/generated/newfile.txt b/src/generated/newfile.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/generated/newfile.txt\n@@ -0,0 +1 @@\n+new content",
          stagedDiff: "",
          untracked: [{ path: "src/generated/newfile.txt", readable: true }],
          hasChanges: true
        }),
        validateGitRepo: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "main",
          head: "abc123",
          isMainBranch: true
        }),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockResolvedValue(undefined)
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const mockStatuses = [
      { ses_test123: { status: "running" } },
      { ses_test123: { status: "idle" } }
    ];
    let callCount = 0;
    mockClient.getSessionStatus.mockImplementation(() => Promise.resolve(mockStatuses[callCount++] || { ses_test123: { status: "idle" } }));

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Test on main",
      allowMain: true,
      timeoutMs: 10000,
      pollIntervalMs: 10
    });

    const content = result.structuredContent as any;
    expect(content.success).toBe(true);
  });

  it("requires clean repo when requireClean is true (default)", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        assertClean: vi.fn().mockRejectedValue(new Error("Repository /tmp/test/repo has uncommitted changes. Commit or stash them first."))
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Test",
      requireClean: true
    });

    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toContain("uncommitted changes");
  });

  it("skips clean check when requireClean is false", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "abc123",
            clean: false,
            porcelain: "## feature-branch\n M existing.txt",
            untracked: [],
            modified: ["existing.txt"],
            staged: []
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "def456",
            clean: false,
            porcelain: "## feature-branch\n M existing.txt\n M src/generated/newfile.txt",
            untracked: ["src/generated/newfile.txt"],
            modified: ["existing.txt"],
            staged: []
          }),
        getGitDiffIncludingUntracked: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          diff: "diff --git a/src/generated/newfile.txt b/src/generated/newfile.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/generated/newfile.txt\n@@ -0,0 +1 @@\n+new content",
          stagedDiff: "",
          untracked: [{ path: "src/generated/newfile.txt", readable: true }],
          hasChanges: true
        }),
        validateGitRepo: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "feature-branch",
          head: "abc123",
          isMainBranch: false
        }),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockResolvedValue(undefined)
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    const mockStatuses = [
      { ses_test123: { status: "running" } },
      { ses_test123: { status: "idle" } }
    ];
    let callCount = 0;
    mockClient.getSessionStatus.mockImplementation(() => Promise.resolve(mockStatuses[callCount++] || { ses_test123: { status: "idle" } }));

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Test with dirty repo",
      requireClean: false,
      timeoutMs: 10000,
      pollIntervalMs: 10
    });

    const content = result.structuredContent as any;
    expect(content.success).toBe(true);
  });
});

describe("MCP Tools - ia_dev_run_task additional scenarios", () => {
  it("returns success false when OpenCode reports error status even with Git changes", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "abc123",
            clean: true,
            porcelain: "## feature-branch",
            untracked: [],
            modified: [],
            staged: []
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "def456",
            clean: false,
            porcelain: "## feature-branch\n M src/generated/newfile.txt",
            untracked: ["src/generated/newfile.txt"],
            modified: [],
            staged: []
          }),
        getGitDiffIncludingUntracked: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          diff: "diff --git a/src/generated/newfile.txt b/src/generated/newfile.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/generated/newfile.txt\n@@ -0,0 +1 @@\n+new content",
          stagedDiff: "",
          untracked: [{ path: "src/generated/newfile.txt", readable: true }],
          hasChanges: true
        }),
        validateGitRepo: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "feature-branch",
          head: "abc123",
          isMainBranch: false
        }),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockResolvedValue(undefined)
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSessionStatus.mockResolvedValue({ ses_test123: { status: "error", error: "Something failed" } });

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Create a test file",
      allowMain: true,
      timeoutMs: 10000,
      pollIntervalMs: 10,
      includeMessages: true,
      messageLimit: 10
    });

    const content = result.structuredContent as any;
    expect(content.success).toBe(false);
    expect(content.error).toContain("error");
  });

  it("returns success false when OpenCode reports cancelled status even with Git changes", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "abc123",
            clean: true,
            porcelain: "## feature-branch",
            untracked: [],
            modified: [],
            staged: []
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "def456",
            clean: false,
            porcelain: "## feature-branch\n M src/generated/newfile.txt",
            untracked: ["src/generated/newfile.txt"],
            modified: [],
            staged: []
          }),
        getGitDiffIncludingUntracked: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          diff: "diff --git a/src/generated/newfile.txt b/src/generated/newfile.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/generated/newfile.txt\n@@ -0,0 +1 @@\n+new content",
          stagedDiff: "",
          untracked: [{ path: "src/generated/newfile.txt", readable: true }],
          hasChanges: true
        }),
        validateGitRepo: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "feature-branch",
          head: "abc123",
          isMainBranch: false
        }),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockResolvedValue(undefined)
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSessionStatus.mockResolvedValue({ ses_test123: { status: "cancelled" } });

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Create a test file",
      allowMain: true,
      timeoutMs: 10000,
      pollIntervalMs: 10,
      includeMessages: true,
      messageLimit: 10
    });

    const content = result.structuredContent as any;
    expect(content.success).toBe(false);
    expect(content.error).toContain("cancelled");
  });

  it("returns success true when OpenCode reports completed status with Git changes", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "abc123",
            clean: true,
            porcelain: "## feature-branch",
            untracked: [],
            modified: [],
            staged: []
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "def456",
            clean: false,
            porcelain: "## feature-branch\n M src/generated/newfile.txt",
            untracked: ["src/generated/newfile.txt"],
            modified: [],
            staged: []
          }),
        getGitDiffIncludingUntracked: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          diff: "diff --git a/src/generated/newfile.txt b/src/generated/newfile.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/generated/newfile.txt\n@@ -0,0 +1 @@\n+new content",
          stagedDiff: "",
          untracked: [{ path: "src/generated/newfile.txt", readable: true }],
          hasChanges: true
        }),
        validateGitRepo: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "feature-branch",
          head: "abc123",
          isMainBranch: false
        }),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockResolvedValue(undefined)
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSessionStatus.mockResolvedValue({ ses_test123: { status: "completed" } });

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Create a test file",
      allowMain: true,
      timeoutMs: 10000,
      pollIntervalMs: 10,
      includeMessages: true,
      messageLimit: 10
    });

    const content = result.structuredContent as any;
    expect(content.success).toBe(true);
    expect(content.gitVerification.gitChanged).toBe(true);
  });

  it("returns success false when repo initially dirty, requireClean:false, and task produces no new changes", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "abc123",
            clean: false,
            porcelain: "## feature-branch\n M existing.txt",
            untracked: [],
            modified: ["existing.txt"],
            staged: []
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo",
            topLevel: "/tmp/test/repo",
            branch: "feature-branch",
            head: "abc123",
            clean: false,
            porcelain: "## feature-branch\n M existing.txt",
            untracked: [],
            modified: ["existing.txt"],
            staged: []
          }),
        getGitDiffIncludingUntracked: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          diff: "",
          stagedDiff: "",
          untracked: [],
          hasChanges: false
        }),
        validateGitRepo: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo",
          topLevel: "/tmp/test/repo",
          branch: "feature-branch",
          head: "abc123",
          isMainBranch: false
        }),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockResolvedValue(undefined)
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });

    mockClient.getSessionStatus.mockResolvedValue({ ses_test123: { status: "idle" } });

    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo",
      prompt: "Do nothing",
      requireClean: false,
      allowMain: true,
      timeoutMs: 10000,
      pollIntervalMs: 10,
      includeMessages: true,
      messageLimit: 10
    });

    const content = result.structuredContent as any;
    expect(content.success).toBe(false);
    expect(content.error).toContain("no Git changes detected");
  });
});
describe("MCP Tools - ia_dev_run_task post-hoc guards", () => {
  function runTaskWithFinalStatus(finalStatus: Record<string, unknown>) {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo", topLevel: "/tmp/test/repo", branch: "feature-branch",
            head: "abc123", clean: true, porcelain: "## feature-branch",
            untracked: [], modified: [], staged: []
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo", topLevel: "/tmp/test/repo", branch: "feature-branch",
            head: "def456", clean: false, porcelain: "", ...finalStatus
          }),
        getGitDiffIncludingUntracked: vi.fn().mockResolvedValue({
          repoPath: "/tmp/test/repo", topLevel: "/tmp/test/repo",
          diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y",
          stagedDiff: "", untracked: [{ path: "src/a.ts", readable: true }], hasChanges: true
        })
      }
    });
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });
    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    return tool.handler({
      repoPath: "/tmp/test/repo", prompt: "edit", timeoutMs: 10000, pollIntervalMs: 10, includeMessages: false
    }).then(result => result.structuredContent as any);
  }

  it("fails the task when the agent writes outside write_paths", async () => {
    const content = await runTaskWithFinalStatus({
      untracked: ["config/secrets/leak.txt"], modified: [], staged: []
    });
    expect(content.success).toBe(false);
    expect(content.error).toContain("outside the profile write policy");
    expect(content.pathPolicy.deniedPaths).toContain("config/secrets/leak.txt");
  });

  it("fails the task when the agent touches protected_paths", async () => {
    const content = await runTaskWithFinalStatus({
      untracked: [], modified: [".github/workflows/ci.yml"], staged: []
    });
    expect(content.success).toBe(false);
    expect(content.pathPolicy.deniedPaths).toContain(".github/workflows/ci.yml");
  });

  it("fails the task when the agent stages a path outside write_paths", async () => {
    const content = await runTaskWithFinalStatus({
      untracked: [], modified: [], staged: ["docs/notes.md"]
    });
    expect(content.success).toBe(false);
    expect(content.pathPolicy.deniedPaths).toContain("docs/notes.md");
  });

  it("allows tracked and untracked changes inside write_paths", async () => {
    const content = await runTaskWithFinalStatus({
      untracked: ["src/new.ts"], modified: ["src/existing.ts"], staged: []
    });
    expect(content.success).toBe(true);
    expect(content.pathPolicy.deniedPaths).toEqual([]);
    expect(content.pathPolicy.changedPaths).toEqual(["src/existing.ts", "src/new.ts"]);
  });

  it("fails closed when the session actually ran a non-free model", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo", topLevel: "/tmp/test/repo", branch: "feature-branch",
            head: "abc123", clean: true, porcelain: "## feature-branch", untracked: [], modified: [], staged: []
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo", topLevel: "/tmp/test/repo", branch: "feature-branch",
            head: "def456", clean: false, porcelain: " M src/a.ts", untracked: [], modified: ["src/a.ts"], staged: []
          })
      }
    });
    mockClient.getMessages.mockResolvedValue([
      { info: { role: "assistant", providerID: "anthropic", modelID: "claude-3-opus", cost: 0 }, parts: [] }
    ]);
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });
    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo", prompt: "edit", timeoutMs: 10000, pollIntervalMs: 10, includeMessages: false
    });
    const content = result.structuredContent as any;
    expect(content.success).toBe(false);
    expect(content.error).toMatch(/non-registered model/);
  });

  it("fails closed when the session reported a nonzero cost", async () => {
    const { config, processManager, state, mockClient } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo", topLevel: "/tmp/test/repo", branch: "feature-branch",
            head: "abc123", clean: true, porcelain: "## feature-branch", untracked: [], modified: [], staged: []
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo", topLevel: "/tmp/test/repo", branch: "feature-branch",
            head: "def456", clean: false, porcelain: " M src/a.ts", untracked: [], modified: ["src/a.ts"], staged: []
          })
      }
    });
    mockClient.getMessages.mockResolvedValue([
      { info: { role: "assistant", providerID: "opencode", modelID: "mimo-v2.6-flash-free", cost: 0.42 }, parts: [] }
    ]);
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });
    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo", prompt: "edit", timeoutMs: 10000, pollIntervalMs: 10, includeMessages: false
    });
    const content = result.structuredContent as any;
    expect(content.success).toBe(false);
    expect(content.error).toMatch(/above the free-only budget/);
  });

  it("never resubmits the prompt after an unknown submission outcome", async () => {
    const { config, processManager, state, mockClient } = createMockContext();
    mockClient.sendMessage.mockRejectedValue(
      new OpencodeHttpError(503, "Service Unavailable", "/session/s/prompt_async", "upstream busy")
    );
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });
    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo", prompt: "edit", timeoutMs: 10000, pollIntervalMs: 10
    });
    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toMatch(/outcome is unknown/);
    expect(content.error).toMatch(/NOT resubmitted/);
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not resubmit after an explicit quota rejection and explains why", async () => {
    const { config, processManager, state, mockClient } = createMockContext();
    mockClient.sendMessage.mockRejectedValue(
      new OpencodeHttpError(429, "Too Many Requests", "/session/s/prompt_async", "slow down")
    );
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });
    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo", prompt: "edit", timeoutMs: 10000, pollIntervalMs: 10
    });
    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toMatch(/429/);
    expect(content.error).toMatch(/not resubmitted/);
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not resubmit after a deadline expiry", async () => {
    const { config, processManager, state, mockClient } = createMockContext();
    mockClient.sendMessage.mockRejectedValue(new OpencodeRequestTimeoutError("POST", "/session/s/prompt_async", 30000));
    const server = createBridgeMcpServer({ config, processManager: processManager as any, state: state as any });
    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo", prompt: "edit", timeoutMs: 10000, pollIntervalMs: 10
    });
    const content = result.structuredContent as any;
    expect(content.ok).toBe(false);
    expect(content.error).toMatch(/outcome is unknown/);
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("MCP Tools - dirty path attribution by fingerprint", () => {
  const fp = (path: string, worktree: string | null, index: string | null) =>
    ({ path, worktree, index, mode: 33188, absent: worktree === null });

  function status(over: Record<string, unknown>) {
    return {
      repoPath: "/tmp/test/repo", topLevel: "/tmp/test/repo", branch: "feature-branch",
      porcelain: "", untracked: [], modified: [], staged: [], ...over
    };
  }

  /**
   * One mock context per scenario. The git mocks go through the gitMocks
   * overrides so no second createMockContext call can clobber them, and
   * the snapshot/fingerprint mocks are wired on the module afterwards.
   */
  async function runScenario(initial: Record<string, unknown>, final: Record<string, unknown>,
                             before: ReturnType<typeof fp>[], after: ReturnType<typeof fp>[]) {
    const { config, processManager, state } = createMockContext({
      gitMocks: {
        getGitStatus: vi.fn()
          .mockResolvedValueOnce(status({ head: "abc123", clean: false, ...initial }))
          .mockResolvedValueOnce(status({ head: "def456", clean: false, ...final })),
        getGitDiffIncludingUntracked: vi.fn()
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo", topLevel: "/tmp/test/repo",
            diff: "", stagedDiff: "", untracked: [], hasChanges: false
          })
          .mockResolvedValueOnce({
            repoPath: "/tmp/test/repo", topLevel: "/tmp/test/repo",
            diff: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b",
            stagedDiff: "", untracked: [], hasChanges: true
          }),
        validateGitRepo: vi.fn().mockResolvedValue(status({ head: "abc123", isMainBranch: false })),
        assertClean: vi.fn().mockResolvedValue(undefined),
        assertNotMain: vi.fn().mockResolvedValue(undefined)
      }
    });
    gitModule.captureGitSnapshot.mockReset()
      .mockImplementationOnce(async (_p: string, diff: any, head: string) =>
        ({ head, diff: diff.diff, stagedDiff: diff.stagedDiff, untracked: diff.untracked, pathFingerprints: [] }))
      .mockImplementationOnce(async (_p: string, diff: any, head: string) =>
        ({ head: `${head}-later`, diff: `${diff.diff}extra`, stagedDiff: diff.stagedDiff,
           untracked: diff.untracked, pathFingerprints: [] }));
    gitModule.capturePathFingerprints.mockReset()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    const server = createBridgeMcpServer({
      config, processManager: processManager as any, state: state as any
    });
    const tool = (server as any)._registeredTools?.ia_dev_run_task;
    const result = await tool.handler({
      repoPath: "/tmp/test/repo", prompt: "edit", requireClean: false,
      timeoutMs: 10000, pollIntervalMs: 10, includeMessages: false
    });
    return result.structuredContent as any;
  }

  it("does not blame a pre-existing dirty file the task never touched", async () => {
    const content = await runScenario(
      { modified: ["existing.txt"] }, { modified: ["existing.txt"] },
      [fp("existing.txt", "aaa", "bbb")], [fp("existing.txt", "aaa", "bbb")]
    );
    expect(content.success).toBe(true);
    expect(content.pathPolicy.changedPaths).toEqual([]);
    expect(content.pathPolicy.deniedPaths).toEqual([]);
  });

  it("fails when the task edits a pre-existing dirty file again outside write_paths", async () => {
    const content = await runScenario(
      { modified: ["existing.txt"] }, { modified: ["existing.txt"] },
      [fp("existing.txt", "aaa", "bbb")], [fp("existing.txt", "zzz", "bbb")]
    );
    expect(content.success).toBe(false);
    expect(content.pathPolicy.deniedPaths).toContain("existing.txt");
    expect(content.error).toContain("outside the profile write policy");
  });

  it("fails when the task re-stages a pre-existing modified file", async () => {
    const content = await runScenario(
      { modified: ["existing.txt"] }, { staged: ["existing.txt"] },
      [fp("existing.txt", "aaa", null)], [fp("existing.txt", "aaa", "ccc")]
    );
    expect(content.success).toBe(false);
    expect(content.pathPolicy.deniedPaths).toContain("existing.txt");
  });

  it("allows a pre-existing dirty file re-touched inside write_paths", async () => {
    const content = await runScenario(
      { modified: ["src/pre.ts"] }, { modified: ["src/pre.ts"] },
      [fp("src/pre.ts", "aaa", "bbb")], [fp("src/pre.ts", "zzz", "bbb")]
    );
    expect(content.success).toBe(true);
    expect(content.pathPolicy.changedPaths).toContain("src/pre.ts");
    expect(content.pathPolicy.deniedPaths).toEqual([]);
  });

  it("attributes a pre-existing untracked file the task overwrote", async () => {
    const content = await runScenario(
      { untracked: ["src/notes.ts"] }, { untracked: ["src/notes.ts"] },
      [fp("src/notes.ts", "aaa", null)], [fp("src/notes.ts", "zzz", null)]
    );
    expect(content.success).toBe(true);
    expect(content.pathPolicy.changedPaths).toContain("src/notes.ts");
    expect(content.pathPolicy.deniedPaths).toEqual([]);
  });

  it("attributes a new file created by the task", async () => {
    const content = await runScenario(
      {}, { untracked: ["src/new.ts"] },
      [], [fp("src/new.ts", "new", null)]
    );
    expect(content.success).toBe(true);
    expect(content.pathPolicy.changedPaths).toEqual(["src/new.ts"]);
    expect(content.pathPolicy.deniedPaths).toEqual([]);
  });

  it("does not attribute a pre-existing change the task reverted (documented limitation)", async () => {
    const content = await runScenario(
      { modified: ["reverted.txt"] }, { modified: [] },
      [fp("reverted.txt", "aaa", "bbb")], []
    );
    // The revert is real task work, but the final physical state holds no
    // diff for the path, so no path is attributed. MIGRATION.md documents
    // this limitation explicitly.
    expect(content.pathPolicy.changedPaths).toEqual([]);
    expect(content.pathPolicy.deniedPaths).toEqual([]);
  });

  it("fails when the task edits a pre-existing protected file again", async () => {
    const content = await runScenario(
      { modified: [".github/workflows/ci.yml"] }, { modified: [".github/workflows/ci.yml"] },
      [fp(".github/workflows/ci.yml", "aaa", "bbb")], [fp(".github/workflows/ci.yml", "zzz", "bbb")]
    );
    expect(content.success).toBe(false);
    expect(content.pathPolicy.deniedPaths).toContain(".github/workflows/ci.yml");
  });
});
