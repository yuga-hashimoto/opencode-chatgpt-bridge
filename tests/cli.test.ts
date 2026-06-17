import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cli = ["exec", "tsx", "src/cli.ts"];

describe("CLI", () => {
  it("prints help", async () => {
    const result = await execFileAsync("pnpm", [...cli, "help"], { timeout: 10000 });
    expect(result.stdout).toContain("opencode-chatgpt-bridge init");
    expect(result.stdout).toContain("opencode-chatgpt-bridge doctor");
  });
});
