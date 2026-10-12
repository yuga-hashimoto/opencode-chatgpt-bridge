import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cli = ["tsx", "src/cli.ts"];

async function runCli(args: string[]): Promise<string> {
  try {
    return (await execFileAsync("npx", args, { timeout: 30000 })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return (await execFileAsync("corepack", ["pnpm", "exec", "tsx", "src/cli.ts", ...args], { timeout: 60000 })).stdout;
  }
}

describe("CLI", () => {
  it("prints help", async () => {
    const stdout = await runCli([...cli, "help"]);
    expect(stdout).toContain("opencode-chatgpt-bridge init");
    expect(stdout).toContain("opencode-chatgpt-bridge doctor");
  }, 60000);
});
