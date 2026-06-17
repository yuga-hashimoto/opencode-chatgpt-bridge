import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initEnv } from "../src/config/bootstrap.js";

describe("initEnv", () => {
  it("creates a ready-to-use env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-init-"));
    const envPath = join(dir, ".env");
    const result = await initEnv({ envPath, allowedRoots: [dir] });
    const content = await readFile(envPath, "utf8");
    const mode = (await stat(envPath)).mode & 0o777;

    expect(result.created).toBe(true);
    expect(result.token.length).toBeGreaterThan(20);
    expect(content).toContain("OPENCODE_BRIDGE_TOKEN=");
    expect(content).toContain("OPENCODE_BRIDGE_TUNNEL=cloudflare");
    expect(content).toContain(dir);
    expect(mode).toBe(0o600);
  });
});
