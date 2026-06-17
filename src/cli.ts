#!/usr/bin/env node
import process from "node:process";
import { execPath } from "node:process";
import { loadConfig } from "./config/env.js";
import { initEnv } from "./config/bootstrap.js";
import { createRuntime, startHttpServer } from "./server/http.js";
import { checkOpencodeCli } from "./opencode/setup.js";
import { getSetupGuide } from "./setupGuide.js";
import { startCloudflareTunnel } from "./tunnel/cloudflare.js";
import { startTailscaleFunnel } from "./tunnel/tailscale.js";
import { getServiceStatus, installService, uninstallService } from "./service/launchd.js";

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function getArgValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === name) return argv[i + 1];
    if (item?.startsWith(`${name}=`)) return item.slice(name.length + 1);
  }
  return undefined;
}

function printHelp(): void {
  console.log(`opencode-chatgpt-bridge

Usage:
  opencode-chatgpt-bridge init [--allowed-roots <path:path>]
  opencode-chatgpt-bridge start [options]
  opencode-chatgpt-bridge doctor [options]
  opencode-chatgpt-bridge install-service
  opencode-chatgpt-bridge uninstall-service
  opencode-chatgpt-bridge service-status

Common options:
  --host <host>                  Bridge host, default 127.0.0.1
  --port <port>                  Bridge port, default 8787
  --allowed-roots <path:path>    Colon-separated repo roots ChatGPT may access
  --token <token>                Bearer token for /mcp
  --tunnel cloudflare|tailscale|none
                                  Start Cloudflare quick tunnel or Tailscale Funnel
  --tailscale-bin <bin>          Tailscale CLI path, default macOS app CLI
  --opencode-bin <bin>           opencode binary, default opencode

Background mode on macOS:
  opencode-chatgpt-bridge install-service
  opencode-chatgpt-bridge service-status
  opencode-chatgpt-bridge uninstall-service

Recommended first run:
  opencode-chatgpt-bridge init --allowed-roots /Volumes/MOVESPEED/Documents/GitHub
  opencode-chatgpt-bridge install-service
`);
}

function printServiceStatus(status: Awaited<ReturnType<typeof getServiceStatus>>): void {
  console.log(JSON.stringify(status, null, 2));
  if (status.loaded) {
    console.log(`Service is loaded${status.pid ? ` with pid ${status.pid}` : ""}.`);
  } else if (status.installed) {
    console.log("Service plist exists but is not loaded.");
  } else {
    console.log("Service is not installed.");
  }
  console.log(`Logs: ${status.stdoutPath}`);
  console.log(`Errors: ${status.stderrPath}`);
}

async function main(): Promise<void> {
  const command = process.argv[2]?.startsWith("--") ? "start" : process.argv[2] ?? "start";

  if (command === "help" || hasFlag("--help") || hasFlag("-h")) {
    printHelp();
    return;
  }

  if (command === "init") {
    const roots = getArgValue("--allowed-roots")?.split(":").filter(Boolean);
    const result = await initEnv({ allowedRoots: roots, force: hasFlag("--force") });
    if (result.created) {
      console.log(`Created ${result.path}`);
      console.log("Next: run `pnpm run build && pnpm run install-service` or `opencode-chatgpt-bridge install-service`.");
    } else {
      console.log(`${result.path} already exists. Use --force to overwrite.`);
    }
    return;
  }

  if (command === "install-service") {
    const config = loadConfig(process.argv.slice(3));
 const status = await installService({ repoDir: process.cwd(), nodeBin: execPath, tailscaleBin: config.tailscaleBin, bridgeToken: config.bridgeToken });
    printServiceStatus(status);
    return;
  }

  if (command === "uninstall-service") {
    const status = await uninstallService();
    printServiceStatus(status);
    return;
  }

  if (command === "service-status") {
    const status = await getServiceStatus();
    printServiceStatus(status);
    return;
  }

  const config = loadConfig(command === "start" || command === "doctor" ? process.argv.slice(3) : process.argv.slice(2));
  const opencodeStatus = await checkOpencodeCli(config);

  if (command === "doctor") {
    console.log(getSetupGuide({ config, localUrl: `http://${config.host}:${config.port}`, opencodeStatus }));
    return;
  }

  const runtime = createRuntime(config);
  await startHttpServer(runtime);

  const localUrl = `http://${config.host}:${config.port}`;
  let publicUrl: string | undefined;

  if (config.tunnel === "cloudflare") {
    console.log("Starting Cloudflare quick tunnel...");
    const tunnel = startCloudflareTunnel(config.cloudflaredBin, localUrl);
    publicUrl = await tunnel.url;
    process.once("exit", () => tunnel.process.kill("SIGTERM"));
  }

  if (config.tunnel === "tailscale") {
    console.log("Starting Tailscale Funnel...");
    const tunnel = startTailscaleFunnel(config.tailscaleBin, localUrl);
    publicUrl = await tunnel.url;
    process.once("exit", () => tunnel.process.kill("SIGTERM"));
  }

  console.log(getSetupGuide({ config, localUrl, publicUrl, opencodeStatus }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
