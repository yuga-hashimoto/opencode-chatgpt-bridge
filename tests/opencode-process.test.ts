import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeProcessManager } from "../src/opencode/process.js";
import type { BridgeConfig } from "../src/types.js";

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    autoPort: true,
    allowedHosts: ["127.0.0.1"],
    allowedRoots: [tmpdir()],
    opencodeBin: "opencode",
    opencodeHost: "127.0.0.1",
    opencodePortStart: 41_999,
    opencodeUsername: "opencode",
    stateDir: await_state_dir(),
    tunnel: "none",
    tailscaleBin: "tailscale",
    cloudflaredBin: "cloudflared",
    ...overrides
  };
}

let stateDir: string | undefined;
async function await_state_dir(): Promise<string> {
  stateDir ??= await mkdtemp(join(tmpdir(), "bridge-state-"));
  return stateDir;
}

describe("OpencodeProcessManager server launch", () => {
  it("fails fast and clearly when the opencode binary does not exist", async () => {
    const repo = await mkdtemp(join(tmpdir(), "bridge-repo-"));
    const missing = join(repo, "opencode-does-not-exist");
    const manager = new OpencodeProcessManager(config({ opencodeBin: missing }));

    const started = Date.now();
    try {
      await expect(manager.ensure(repo)).rejects.toThrow(/opencode/i);
      // A missing binary must be reported as a startup failure, not discovered
      // after the full 20s health timeout, and the port must not leak.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await manager.stop(repo);
      await rm(repo, { recursive: true, force: true });
      if (stateDir) await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not crash the process on a spawn error", async () => {
    const repo = await mkdtemp(join(tmpdir(), "bridge-repo-"));
    const missing = join(repo, "also-missing");
    const before = process.listenerCount("uncaughtException");
    const manager = new OpencodeProcessManager(config({ opencodeBin: missing }));
    try {
      await manager.ensure(repo).catch(() => undefined);
      // Give any pending spawn 'error' event a chance to fire.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(process.listenerCount("uncaughtException")).toBe(before);
    } finally {
      await manager.stop(repo);
      await rm(repo, { recursive: true, force: true });
      if (stateDir) await rm(stateDir, { recursive: true, force: true });
    }
  });
});
