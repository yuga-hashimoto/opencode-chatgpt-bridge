import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeMcpServer } from "../src/mcp/tools.js";
import { isSuccessfulTerminalOpencodeStatus } from "../src/types.js";
import { getGitStatus, getGitDiff } from "../src/git/repository.js";

let repo: string;
function git(...args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }); }
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "ia-physical-"));
  git("init", "-b", "feature"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  await writeFile(join(repo, ".ia-dev.yml"), [
    'version: "2.1"',
    'profile: "code-change"',
    'goal: "Fixture profile for physical verification tests"',
    "paths:",
    "  context_paths:",
    '    - "**/*"',
    "  write_paths:",
    '    - "**/*"',
    "models:",
    '  author: "mimo-v2.6-flash-free"',
    '  reviewer: "space-bunny-free"',
    ""
  ].join("\n"));
  await writeFile(join(repo, "tracked.txt"), "original\n\n"); git("add", "."); git("commit", "-m", "fixture");
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });
function bridge(action: () => Promise<unknown> = async () => {}, status = { type: "idle" }) {
  const client = { listProviders: vi.fn(async () => ({ connected: ["opencode"], all: [{ id: "opencode", name: "opencode", env: [], models: Object.fromEntries(["mimo-v2.6-flash-free", "space-bunny-free"].map(id => [id, { id, name: id, release_date: "2026-01-01", attachment: false, reasoning: false, temperature: true, tool_call: true, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, limit: { context: 200000, output: 8192 }, options: {} }])) }], default: {} })), createSession: vi.fn(async () => ({ id: "s" })), sendMessage: vi.fn(action), getSessionStatus: async () => ({ s: status }), getMessages: async () => [{ info: { role: "assistant", providerID: "opencode", modelID: "mimo-v2.6-flash-free", cost: 0 }, parts: [] }], getDiff: vi.fn(async () => [{ diff: "claimed change" }]), getSession: vi.fn(async (sessionId: string) => ({ id: sessionId, directory: repo })) };
  const server = createBridgeMcpServer({ config: { allowedRoots: [repo] } as any, processManager: { ensure: async () => ({ baseUrl: "http://localhost:1" }), clientFor: () => client } as any, state: { createSession: async (x: unknown) => x, getSession: async () => ({ opencodeSessionId: "ses_old", repoPath: repo, baseUrl: "http://localhost:2" }), updateSession: async (_id: string, patch: Record<string, unknown>) => ({ opencodeSessionId: "ses_old", repoPath: repo, baseUrl: "http://localhost:1", ...patch }) } as any });
  const tool = (server as any)._registeredTools.ia_dev_run_task;
  return { server, client, run: async (extra = {}) => (await tool.handler(tool.inputSchema.parse({ repoPath: repo, prompt: "test", includeMessages: false, ...extra }))).structuredContent };
}
describe("physical task verification", () => {
  it("rejects unavailable inventory before creating a task session", { timeout: 10000 }, async () => {
    const b = bridge(); b.client.listProviders.mockRejectedValue(new Error("offline"));
    expect((await b.run()).ok).toBe(false);
    expect(b.client.createSession).not.toHaveBeenCalled();
    expect(b.client.sendMessage).not.toHaveBeenCalled();
  });
  it("rejects a newly paid author before creating a task session", { timeout: 10000 }, async () => {
    const b = bridge(); const inventory = await b.client.listProviders();
    inventory.all[0]!.models["mimo-v2.6-flash-free"]!.cost.input = 1;
    b.client.listProviders.mockResolvedValue(inventory);
    expect((await b.run()).error).toContain("verified zero-cost");
    expect(b.client.createSession).not.toHaveBeenCalled();
    expect(b.client.sendMessage).not.toHaveBeenCalled();
  });
  it("rejects an unparseable inventory before creating a task session", { timeout: 10000 }, async () => {
    const b = bridge(); b.client.listProviders.mockResolvedValue({ all: [], connected: [] });
    expect((await b.run()).ok).toBe(false);
    expect(b.client.createSession).not.toHaveBeenCalled();
    expect(b.client.sendMessage).not.toHaveBeenCalled();
  });
  it("rejects ambiguous provider records before creating a task session", { timeout: 10000 }, async () => {
    const b = bridge(); const inventory = await b.client.listProviders();
    inventory.all.push(inventory.all[0]!);
    b.client.listProviders.mockResolvedValue(inventory);
    expect((await b.run()).error).toContain("verified zero-cost");
    expect(b.client.createSession).not.toHaveBeenCalled();
    expect(b.client.sendMessage).not.toHaveBeenCalled();
  });
  it("rejects a model record whose id does not match its key", { timeout: 10000 }, async () => {
    const b = bridge(); const inventory = await b.client.listProviders();
    inventory.all[0]!.models["mimo-v2.6-flash-free"]!.id = "something-else";
    b.client.listProviders.mockResolvedValue(inventory);
    expect((await b.run()).error).toContain("verified zero-cost");
    expect(b.client.createSession).not.toHaveBeenCalled();
    expect(b.client.sendMessage).not.toHaveBeenCalled();
  });

  it("sends the profile author model explicitly once", { timeout: 10000 }, async () => {
    const b = bridge(async () => writeFile(join(repo, "tracked.txt"), "edit"));
    expect((await b.run()).success).toBe(true);
    expect(b.client.sendMessage).toHaveBeenCalledTimes(1);
    expect(b.client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ providerID: "opencode", modelID: "mimo-v2.6-flash-free" }));
  });
  it.each([
    { providerID: "paid", modelID: "mimo-v2.6-flash-free" },
    { providerID: "opencode", modelID: "paid-model" },
    { providerID: "opencode" }, { modelID: "mimo-v2.6-flash-free" },
    { providerID: "opencode", modelID: "space-bunny-free" }
  ])("rejects unsafe model overrides before session creation: %j", { timeout: 10000 }, async override => {
    const b = bridge(); expect((await b.run(override)).ok).toBe(false);
    expect(b.client.createSession).not.toHaveBeenCalled();
    expect(b.client.sendMessage).not.toHaveBeenCalled();
  });
  it.each(["Quota exceeded", "Rate limited: 429", "Provider unavailable: 503", "Connection refused"])("does not reuse reviewer or duplicate uncertain submissions: %s", { timeout: 10000 }, async message => {
    const b = bridge(async () => { throw new Error(message); });
    expect((await b.run()).ok).toBe(false);
    expect(b.client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not treat a legacy idle field as overriding a current error", () => {
    expect(isSuccessfulTerminalOpencodeStatus({ type: "error", status: "idle" })).toBe(false);
    expect(isSuccessfulTerminalOpencodeStatus({ status: "completed" })).toBe(true);
  });
  it("detects new edits within a preexisting tracked binary diff", { timeout: 10000 }, async () => {
    await writeFile(join(repo, "binary"), Buffer.from([0, 255])); git("add", "."); git("commit", "-m", "binary fixture");
    await writeFile(join(repo, "binary"), Buffer.from([0, 254]));
    const b = bridge(async () => writeFile(join(repo, "binary"), Buffer.from([0, 253])));
    expect((await b.run({ requireClean: false })).success).toBe(true);
  });
  it("applies requireClean default before sending any prompt", async () => {
    await writeFile(join(repo, "tracked.txt"), "prior edit"); const b = bridge();
    expect((await b.run()).ok).toBe(false); expect(b.client.sendMessage).not.toHaveBeenCalled();
  });
  it("succeeds with omitted requireClean and a real physical edit", async () => {
    const b = bridge(async () => writeFile(join(repo, "tracked.txt"), "new edit")); expect((await b.run()).success).toBe(true);
  });
  it.each(["unstaged", "staged", "untracked"])("rejects unchanged preexisting %s changes", { timeout: 10000 }, async kind => {
    await writeFile(join(repo, kind === "untracked" ? "new.txt" : "tracked.txt"), "prior edit");
    if (kind === "staged") git("add", ".");
    const b = bridge(); expect((await b.run({ requireClean: false })).success).toBe(false);
  });
  it("detects changed binary content of an existing untracked file", { timeout: 10000 }, async () => {
    await writeFile(join(repo, "new.bin"), Buffer.from([0, 255]));
    const b = bridge(async () => writeFile(join(repo, "new.bin"), Buffer.from([0, 254])));
    expect((await b.run({ requireClean: false })).success).toBe(true);
  });
  it.each(["error", "cancelled"])("rejects %s despite physical edits", { timeout: 10000 }, async type => {
    const b = bridge(async () => writeFile(join(repo, "tracked.txt"), "new edit"), { type }); expect((await b.run()).success).toBe(false);
  });
  it("rejects reported OpenCode changes without physical edits", { timeout: 10000 }, async () => { expect((await bridge().run()).success).toBe(false); });
  it("fails verification if an untracked file becomes unreadable", { timeout: 10000 }, async () => {
    const b = bridge(async () => { await writeFile(join(repo, "restricted"), "x"); await chmod(join(repo, "restricted"), 0); });
    try { const r = await b.run(); expect(r.success).toBe(false); expect(r.error).toContain("verification incomplete"); }
    finally { await chmod(join(repo, "restricted"), 0o600); }
  });
  it.each(["main", "master"])("blocks %s before launching", { timeout: 10000 }, async name => {
    git("branch", "-m", name); const b = bridge(); expect((await b.run()).error).toContain("protected branch"); expect(b.client.sendMessage).not.toHaveBeenCalled();
  });
  it("recovers a session on the current managed server after a restart", { timeout: 10000 }, async () => {
    const b = bridge(); const tool = (b.server as any)._registeredTools.opencode_get_messages;
    const r = await tool.handler(tool.inputSchema.parse({ bridgeSessionId: "old" }));
    expect(r.structuredContent.code).toBeUndefined();
    expect(r.structuredContent.messages).toEqual([{ info: { role: "assistant", providerID: "opencode", modelID: "mimo-v2.6-flash-free", cost: 0 }, parts: [] }]);
    expect(r.structuredContent.managedServer).toBe("http://localhost:1");
  });
  it("does not rebind a session that belongs to a different project", { timeout: 10000 }, async () => {
    const b = bridge(); b.client.getSession.mockResolvedValue({ id: "ses_old", directory: tmpdir() });
    const tool = (b.server as any)._registeredTools.opencode_get_messages;
    const r = await tool.handler(tool.inputSchema.parse({ bridgeSessionId: "old" }));
    expect(r.structuredContent.code).toBe("SESSION_PROJECT_MISMATCH");
    expect(b.client.getDiff).not.toHaveBeenCalled();
  });
  it("fails before launching when the repo has no .ia-dev.yml profile", { timeout: 10000 }, async () => {
    await rm(join(repo, ".ia-dev.yml"));
    const b = bridge(async () => writeFile(join(repo, "tracked.txt"), "new edit"));
    const r = await b.run({ requireClean: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(".ia-dev.yml");
    expect(b.client.sendMessage).not.toHaveBeenCalled();
  });
  it("fails before launching when the profile allows no writes", { timeout: 10000 }, async () => {
    await writeFile(join(repo, ".ia-dev.yml"), [
      'version: "2.1"',
      'profile: "code-change"',
      'goal: "Fixture profile that forbids every write"',
      "paths:",
      "  write_paths: []",
      "models:",
      '  author: "mimo-v2.6-flash-free"',
      '  reviewer: "space-bunny-free"',
      ""
    ].join("\n"));
    const b = bridge(async () => writeFile(join(repo, "tracked.txt"), "new edit"));
    const r = await b.run({ requireClean: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("write_paths");
    expect(b.client.sendMessage).not.toHaveBeenCalled();
  });
  it("keeps staged changes when excluding untracked", async () => {
    await writeFile(join(repo, "tracked.txt"), "staged edit"); git("add", "."); await writeFile(join(repo, "new.txt"), "untracked");
    const tool = (bridge().server as any)._registeredTools.repo_git_diff;
    const r = (await tool.handler(tool.inputSchema.parse({ repoPath: repo, includeUntracked: false }))).structuredContent;
    expect(r.stagedDiff).toContain("staged edit"); expect(r.diff).toBe(""); expect(r.untracked).toEqual([]); expect(r.hasChanges).toBe(true);
  });
  it("preserves Git patch bytes and trailing blank context", async () => {
    await writeFile(join(repo, "tracked.txt"), "changed\n\n"); const r = await getGitDiff(repo); expect(r.diff).toBe(git("diff", "--no-color"));
    expect(() => execFileSync("git", ["-C", repo, "apply", "--check", "--reverse", "-"], { input: r.diff })).not.toThrow();
  });
  it("parses Unicode, newline and tab paths, nested files and rename source records", async () => {
    const name = 'ñ\t"\n.txt'; await mkdir(join(repo, "newdir")); await writeFile(join(repo, "newdir", name), "x");
    git("mv", "tracked.txt", name); await writeFile(join(repo, name), "also modified"); const r = await getGitStatus(repo);
    expect(r.untracked).toEqual([`newdir/${name}`]); expect(r.staged).toEqual([name]); expect(r.modified).toEqual([name]);
  });
});
