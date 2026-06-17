import { randomBytes } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import type { BridgeConfig } from "../types.js";
import { OpencodeClient } from "./client.js";

export type ManagedOpencode = {
  repoPath: string;
  baseUrl: string;
  username: string;
  password?: string;
  port?: number;
  process?: ChildProcess;
  startedAt: string;
};

type LogLine = {
  at: string;
  stream: "stdout" | "stderr";
  text: string;
};

export class OpencodeProcessManager {
  private readonly processes = new Map<string, ManagedOpencode>();
  private readonly logs = new Map<string, LogLine[]>();

  constructor(private readonly config: BridgeConfig) {}

  async ensure(repoPath: string): Promise<ManagedOpencode> {
    if (this.config.opencodeBaseUrl) {
      return {
        repoPath,
        baseUrl: this.config.opencodeBaseUrl.replace(/\/$/, ""),
        username: this.config.opencodeUsername,
        password: this.config.opencodePassword,
        startedAt: new Date().toISOString()
      };
    }

    const existing = this.processes.get(repoPath);
    if (existing && (await this.isHealthy(existing))) return existing;

    const port = await findOpenPort(this.config.opencodePortStart);
    const password = this.config.opencodePassword ?? randomBytes(24).toString("hex");
    const baseUrl = `http://${this.config.opencodeHost}:${port}`;
    const child = spawn(this.config.opencodeBin, ["serve", "--hostname", this.config.opencodeHost, "--port", String(port)], {
      cwd: repoPath,
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: this.config.opencodeUsername,
        OPENCODE_SERVER_PASSWORD: password
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const managed: ManagedOpencode = {
      repoPath,
      baseUrl,
      username: this.config.opencodeUsername,
      password,
      port,
      process: child,
      startedAt: new Date().toISOString()
    };
    this.processes.set(repoPath, managed);
    this.logs.set(repoPath, []);

    const capture = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const entries = this.logs.get(repoPath) ?? [];
      entries.push({ at: new Date().toISOString(), stream, text: chunk.toString("utf8") });
      this.logs.set(repoPath, entries.slice(-100));
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.on("exit", () => {
      const current = this.processes.get(repoPath);
      if (current?.process === child) this.processes.delete(repoPath);
    });

    await waitForHealth(() => this.isHealthy(managed), 20_000);
    return managed;
  }

  clientFor(managed: ManagedOpencode): OpencodeClient {
    return new OpencodeClient({
      baseUrl: managed.baseUrl,
      username: managed.username,
      password: managed.password
    });
  }

  async stop(repoPath?: string): Promise<{ stopped: string[] }> {
    const targets = repoPath ? [...this.processes.entries()].filter(([path]) => path === repoPath) : [...this.processes.entries()];
    const stopped: string[] = [];
    for (const [path, managed] of targets) {
      managed.process?.kill("SIGTERM");
      this.processes.delete(path);
      stopped.push(path);
    }
    return { stopped };
  }

  list(): ManagedOpencode[] {
    return [...this.processes.values()].map((proc) => ({ ...proc, password: proc.password ? "***" : undefined }));
  }

  getLogs(repoPath: string): LogLine[] {
    return this.logs.get(repoPath) ?? [];
  }

  private async isHealthy(managed: ManagedOpencode): Promise<boolean> {
    try {
      const client = this.clientFor(managed);
      const result = await client.health();
      return result.healthy === true;
    } catch {
      return false;
    }
  }
}

async function findOpenPort(start: number): Promise<number> {
  for (let port = start; port < start + 200; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No open port found from ${start} to ${start + 199}`);
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function waitForHealth(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let last = false;
  while (Date.now() - started < timeoutMs) {
    last = await check();
    if (last) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for opencode server to become healthy. Is opencode installed and configured?");
}
