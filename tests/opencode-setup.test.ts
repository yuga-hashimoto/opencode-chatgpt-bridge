import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOpencodeCli, getOpencodeSetupText } from "../src/opencode/setup.js";
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
    opencodePortStart: 42_200,
    opencodeUsername: "opencode",
    stateDir: tmpdir(),
    tunnel: "none",
    tailscaleBin: "tailscale",
    cloudflaredBin: "cloudflared",
    ...overrides
  };
}

describe("opencode CLI detection", () => {
  it("reports not-installed when the binary cannot be executed", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-cli-"));
    const missing = join(root, "opencode-does-not-exist");
    try {
      // `opencode --version` failing must not be swallowed into a
      // "installed, version unknown" verdict.
      const status = await checkOpencodeCli(config({ opencodeBin: missing }));
      expect(status.installed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("explains the failure instead of claiming an unknown version", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-cli-"));
    const missing = join(root, "opencode-does-not-exist");
    try {
      const status = await checkOpencodeCli(config({ opencodeBin: missing }));
      const text = getOpencodeSetupText(status, config()).join("\n");
      expect(text.toLowerCase()).toContain("install");
      expect(text).not.toMatch(/installed\s*\(version unknown\)/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports installed when the binary is a valid executable", async () => {
    const status = await checkOpencodeCli(config({ opencodeBin: process.execPath }));
    expect(status.installed).toBe(true);
    expect(status.version).toMatch(/^v?\d/);
  });
});
