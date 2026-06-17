import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BridgeConfig } from "../types.js";

const execFileAsync = promisify(execFile);

export type OpencodeCliStatus = {
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
};

export async function checkOpencodeCli(config: BridgeConfig): Promise<OpencodeCliStatus> {
  try {
    const [versionResult, pathResult] = await Promise.allSettled([
      execFileAsync(config.opencodeBin, ["--version"], { timeout: 5000 }),
      execFileAsync("which", [config.opencodeBin], { timeout: 5000 })
    ]);
    const version = versionResult.status === "fulfilled" ? versionResult.value.stdout.trim() || versionResult.value.stderr.trim() : undefined;
    const path = pathResult.status === "fulfilled" ? pathResult.value.stdout.trim() : undefined;
    return { installed: true, version, path };
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function getOpencodeSetupText(status: OpencodeCliStatus, config: BridgeConfig): string[] {
  const lines: string[] = [];
  lines.push("6) opencode local setup");
  if (status.installed) {
    lines.push(`   opencode: installed${status.version ? ` (${status.version})` : ""}${status.path ? ` at ${status.path}` : ""}`);
  } else {
    lines.push("   opencode: NOT FOUND");
    lines.push("   Install/login opencode first, then restart this bridge.");
  }
  lines.push("   This bridge starts opencode with:");
  lines.push(`   ${config.opencodeBin} serve --hostname ${config.opencodeHost} --port <auto>`);
  if (config.opencodeBaseUrl) {
    lines.push(`   Existing opencode server mode: ${config.opencodeBaseUrl}`);
  }
  if (config.opencodePassword) {
    lines.push("   OPENCODE_SERVER_PASSWORD: provided; bridge will use Basic Auth to call opencode.");
  } else {
    lines.push("   OPENCODE_SERVER_PASSWORD: not set; bridge will generate a random password per managed opencode server.");
  }
  lines.push("   Provider/model setup: run `opencode` once in your terminal and sign in/configure your model provider if needed.");
  lines.push("   Quick check: `opencode --version` and then `opencode` inside a repo should work before ChatGPT uses this bridge.");
  return lines;
}
