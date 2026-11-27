import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { OpencodeProcessManager } from "../src/opencode/process.js";

async function findFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not get a free test port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

describe("OpencodeProcessManager", () => {
  it("shares one process when the same repo is ensured concurrently", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bridge-opencode-"));
    const repoPath = join(tempDir, "repo");
    const scriptPath = join(tempDir, "fake-opencode");
    const port = await findFreePort();
    await mkdir(repoPath);
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
const http = require("node:http");
const portIndex = process.argv.indexOf("--port");
const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ healthy: true }));
});
server.listen(Number(process.argv[portIndex + 1]), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
      { mode: 0o755 }
    );
    await chmod(scriptPath, 0o755);
    const manager = new OpencodeProcessManager(
      loadConfig(["--opencode-bin", scriptPath, "--opencode-port-start", String(port)])
    );

    try {
      const [first, second] = await Promise.all([manager.ensure(repoPath), manager.ensure(repoPath)]);
      expect(second.process).toBe(first.process);
      expect(manager.list()).toHaveLength(1);

      const exited = once(first.process!, "exit");
      await manager.stop(repoPath);
      await exited;
    } finally {
      await manager.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("cleans up after the configured binary cannot be spawned", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "bridge-opencode-missing-"));
    const manager = new OpencodeProcessManager(
      loadConfig(["--opencode-bin", "/definitely/missing/opencode"])
    );

    try {
      await expect(manager.ensure(repoPath)).rejects.toThrow(/ENOENT/);
      expect(manager.list()).toHaveLength(0);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
