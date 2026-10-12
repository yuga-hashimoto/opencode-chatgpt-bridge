import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BridgeConfig } from "../types.js";

const execFileAsync = promisify(execFile);

export type OpencodeCliStatus = {
  installed: boolean;
  version?: string;
  error?: string;
};

export async function checkOpencodeCli(config: BridgeConfig): Promise<OpencodeCliStatus> {
  try {
    const [versionResult] = await Promise.allSettled([
      execFileAsync(config.opencodeBin, ["--version"], { timeout: 5000 })
    ]);
    // `--version` failing (ENOENT, EACCES, non-zero exit) is the authoritative
    // signal. Promise.allSettled never rejects, so this must be inspected here:
    // without it a missing binary reads as "installed with an unknown version"
    // and the setup guide points the user at the wrong problem.
    if (versionResult.status === "rejected") {
      const reason = versionResult.reason;
      return {
        installed: false,
        error: reason instanceof Error ? reason.message : String(reason)
      };
    }
    const version = versionResult.value.stdout.trim() || versionResult.value.stderr.trim();
    return { installed: true, version };
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
    lines.push(`   opencode: installed${status.version ? ` (${status.version})` : ""}`);
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
