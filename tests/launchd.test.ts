import { describe, expect, it } from "vitest";
import { buildPlist, installService } from "../src/service/launchd.js";

describe("LaunchAgent configuration", () => {
  it("stores the bridge token in the protected service environment", () => {
    const plist = buildPlist({
      label: "test.bridge",
      repoDir: "/tmp/bridge",
      nodeBin: "/usr/bin/node",
      stdoutPath: "/tmp/bridge.log",
      stderrPath: "/tmp/bridge.err.log",
      servicePort: 8790,
      bridgeToken: "secret&token"
    });

    expect(plist).toContain("<key>OPENCODE_BRIDGE_TOKEN</key>");
    expect(plist).toContain("<string>secret&amp;token</string>");
  });

  it("does not install a public service without a bridge token", async () => {
    await expect(
      installService({ repoDir: "/tmp/bridge", nodeBin: "/usr/bin/node", tailscaleBin: "tailscale" })
    ).rejects.toThrow("OPENCODE_BRIDGE_TOKEN is required");
  });
});
