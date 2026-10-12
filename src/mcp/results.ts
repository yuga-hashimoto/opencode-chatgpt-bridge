import type { ToolResult } from "../types.js";

export function toolResult<T extends Record<string, unknown>>(structuredContent: T): ToolResult<T> {
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }]
  };
}

type ToolError = { ok: false; error: string; code?: string };

export function errorResult(message: string, code?: string): ToolResult<ToolError> {
  return toolResult({ ok: false, error: message, ...(code ? { code } : {}) });
}

export async function safeTool<T extends Record<string, unknown>>(fn: () => Promise<T>): Promise<ToolResult<T | ToolError>> {
  try {
    return toolResult(await fn());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
    return errorResult(message, code);
  }
}
