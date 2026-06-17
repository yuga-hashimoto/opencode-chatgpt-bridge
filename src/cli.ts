#!/usr/bin/env node
import process from "node:process";
import { loadConfig, maskToken } from "./config/env.js";
import { createRuntime, startHttpServer } from "./server/http.js";
import { startCloudflareTunnel } from "./tunnel/cloudflare.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = createRuntime(config);
  await startHttpServer(runtime);

  const localUrl = `http://${config.host}:${config.port}`;
  console.log(`opencode-chatgpt-bridge listening at ${localUrl}`);
  console.log(`MCP endpoint: ${localUrl}/mcp`);
  console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
  if (config.bridgeToken) {
    console.log(`Bridge token: ${maskToken(config.bridgeToken)} (send Authorization: Bearer <token>)`);
  } else {
    console.warn("WARNING: OPENCODE_BRIDGE_TOKEN is not set. Do not expose this server publicly without a tunnel/auth layer.");
  }

  if (config.tunnel === "cloudflare") {
    console.log("Starting Cloudflare quick tunnel...");
    const tunnel = startCloudflareTunnel(config.cloudflaredBin, localUrl);
    const publicUrl = await tunnel.url;
    console.log(`Public MCP endpoint: ${publicUrl}/mcp`);
    console.log("Use this URL as the ChatGPT connector URL.");
    process.once("exit", () => tunnel.process.kill("SIGTERM"));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
