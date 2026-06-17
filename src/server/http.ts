import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import process from "node:process";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response, NextFunction } from "express";
import type { BridgeConfig } from "../types.js";
import { maskToken } from "../config/env.js";
import { OpencodeProcessManager } from "../opencode/process.js";
import { StateStore } from "../state/store.js";
import { createBridgeMcpServer } from "../mcp/tools.js";

export type BridgeRuntime = {
  config: BridgeConfig;
  processManager: OpencodeProcessManager;
  state: StateStore;
};

export function createRuntime(config: BridgeConfig): BridgeRuntime {
  return {
    config,
    processManager: new OpencodeProcessManager(config),
    state: new StateStore(config.stateDir)
  };
}

function authMiddleware(config: BridgeConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.bridgeToken) {
      next();
      return;
    }
    const header = req.header("authorization") ?? "";
    const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1];
    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    if (bearer === config.bridgeToken || queryToken === config.bridgeToken) {
      next();
      return;
    }
    res.status(401).json({ error: "Missing or invalid bearer token" });
  };
}

export async function startHttpServer(runtime: BridgeRuntime): Promise<Server> {
  const { config } = runtime;
  const app = createMcpExpressApp();

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      name: "opencode-chatgpt-bridge",
      mcp: "/mcp",
      allowedRoots: config.allowedRoots,
      tokenAuthEnabled: Boolean(config.bridgeToken),
      tokenPreview: maskToken(config.bridgeToken),
      managedProcesses: runtime.processManager.list()
    });
  });

  app.get("/", (_req, res) => {
    res.type("text/plain").send(
      [
        "opencode-chatgpt-bridge is running.",
        "MCP endpoint: /mcp",
        "Health: /health",
        config.bridgeToken ? "Auth: Bearer token required." : "Auth: no bridge token configured; keep this on localhost or set OPENCODE_BRIDGE_TOKEN."
      ].join("\n")
    );
  });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const mcpPostHandler = async (req: Request, res: Response) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    try {
      let transport: StreamableHTTPServerTransport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport;
          }
        });
        transport.onclose = () => {
          const current = transport.sessionId;
          if (current) delete transports[current];
        };
        const server = createBridgeMcpServer(runtime);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid MCP session ID or initialize request" },
          id: null
        });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message }, id: null });
      }
    }
  };

  const mcpGetHandler = async (req: Request, res: Response) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing MCP session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  const mcpDeleteHandler = async (req: Request, res: Response) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing MCP session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  const guard = authMiddleware(config);
  app.post("/mcp", guard, mcpPostHandler);
  app.get("/mcp", guard, mcpGetHandler);
  app.delete("/mcp", guard, mcpDeleteHandler);

  const httpServer = app.listen(config.port, config.host);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", () => resolve());
    httpServer.once("error", reject);
  });

  const shutdown = async () => {
    await runtime.processManager.stop().catch(() => undefined);
    for (const transport of Object.values(transports)) {
      await transport.close().catch(() => undefined);
    }
    httpServer.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  return httpServer;
}
