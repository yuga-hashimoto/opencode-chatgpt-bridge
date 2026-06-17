import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import type { BridgeConfig } from "../types.js";

dotenv.config();

type CliArgs = Record<string, string | boolean>;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw) continue;
    if (!raw.startsWith("--")) continue;
    const withoutPrefix = raw.slice(2);
    const eq = withoutPrefix.indexOf("=");
    if (eq >= 0) {
      args[withoutPrefix.slice(0, eq)] = withoutPrefix.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[withoutPrefix] = next;
      i += 1;
    } else {
      args[withoutPrefix] = true;
    }
  }
  return args;
}

function pick(args: CliArgs, key: string, envKey: string, fallback?: string): string | undefined {
  const arg = args[key];
  if (typeof arg === "string" && arg.length > 0) return arg;
  const env = process.env[envKey];
  if (env && env.length > 0) return env;
  return fallback;
}

function pickNumber(args: CliArgs, key: string, envKey: string, fallback: number): number {
  const value = pick(args, key, envKey, String(fallback));
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key}/${envKey} must be a positive integer`);
  }
  return parsed;
}

function parseAllowedRoots(value?: string): string[] {
  const raw = value?.trim();
  const roots = raw ? raw.split(":") : [process.cwd()];
  return [...new Set(roots.map((root) => resolve(root)).filter(Boolean))];
}

export function loadConfig(argv = process.argv.slice(2)): BridgeConfig {
  const args = parseArgs(argv);
  const allowedRoots = parseAllowedRoots(pick(args, "allowed-roots", "OPENCODE_BRIDGE_ALLOWED_ROOTS"));
  const tunnelRaw = pick(args, "tunnel", "OPENCODE_BRIDGE_TUNNEL", "none")?.toLowerCase();
  const tunnel = tunnelRaw === "cloudflare" ? "cloudflare" : "none";

  return {
    host: pick(args, "host", "OPENCODE_BRIDGE_HOST", "127.0.0.1") ?? "127.0.0.1",
    port: pickNumber(args, "port", "OPENCODE_BRIDGE_PORT", 8787),
    allowedRoots,
    bridgeToken: pick(args, "token", "OPENCODE_BRIDGE_TOKEN"),
    opencodeBaseUrl: pick(args, "opencode-url", "OPENCODE_BASE_URL"),
    opencodeBin: pick(args, "opencode-bin", "OPENCODE_BIN", "opencode") ?? "opencode",
    opencodeHost: pick(args, "opencode-host", "OPENCODE_BRIDGE_OPENCODE_HOST", "127.0.0.1") ?? "127.0.0.1",
    opencodePortStart: pickNumber(args, "opencode-port-start", "OPENCODE_BRIDGE_OPENCODE_PORT_START", 4096),
    opencodeUsername: pick(args, "opencode-username", "OPENCODE_SERVER_USERNAME", "opencode") ?? "opencode",
    opencodePassword: pick(args, "opencode-password", "OPENCODE_SERVER_PASSWORD"),
    stateDir: resolve(pick(args, "state-dir", "OPENCODE_BRIDGE_STATE_DIR", join(homedir(), ".opencode-chatgpt-bridge")) ?? join(homedir(), ".opencode-chatgpt-bridge")),
    tunnel,
    cloudflaredBin: pick(args, "cloudflared-bin", "CLOUDFLARED_BIN", "cloudflared") ?? "cloudflared"
  };
}

export function maskToken(token?: string): string | undefined {
  if (!token) return undefined;
  if (token.length <= 8) return "********";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
