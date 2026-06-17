import { describe, expect, it } from "vitest";
import { getSetupGuide } from "../src/setupGuide.js";
import type { BridgeConfig } from "../src/types.js";

const config: BridgeConfig = {
  host: "127.0.0.1",
  port: 8787,
  allowedRoots: ["/tmp/repos"],
  bridgeToken: "abc123",
  opencodeBin: "opencode",
  opencodeHost: "127.0.0.1",
  opencodePortStart: 4096,
  opencodeUsername: "opencode",
  stateDir: "/tmp/state",
  tunnel: "cloudflare",
  cloudflaredBin: "cloudflared"
};

describe("setup guide", () => {
  it("prints ChatGPT and opencode setup details", () => {
    const guide = getSetupGuide({
      config,
      localUrl: "http://127.0.0.1:8787",
      publicUrl: "https://example.trycloudflare.com",
      opencodeStatus: { installed: true, version: "1.17.7", path: "/usr/local/bin/opencode" }
    });

    expect(guide).toContain("Settings -> Apps & Connectors");
    expect(guide).toContain("https://example.trycloudflare.com/mcp?token=abc123");
    expect(guide).toContain("opencode: installed");
    expect(guide).toContain("opencode serve");
  });
});
