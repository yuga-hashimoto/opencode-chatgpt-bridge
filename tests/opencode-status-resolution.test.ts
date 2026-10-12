import { describe, expect, it, vi } from "vitest";
import { resolveSessionStatus } from "../src/opencode/status.js";

function client(info: Record<string, unknown>, current = {}) {
  return { getMessages: vi.fn(async () => [{ info, parts: [] }]), getSessionStatus: vi.fn(async () => current) };
}
const completed = { role: "assistant", time: { completed: 123 }, finish: "stop" };
describe("sparse OpenCode status resolution", () => {
  it("recognizes a completed assistant after status removal", async () => {
    expect(await resolveSessionStatus(client(completed), "s", {})).toMatchObject({ type: "completed" });
  });
  it.each([{}, { role: "user", time: { completed: 123 } }, { role: "assistant", finish: "stop" }, { ...completed, finish: "tool-calls" }])("does not treat absent status alone as success: %j", async (info) => {
    expect(await resolveSessionStatus(client(info), "s", {})).toBeNull();
  });
  it("preserves an assistant error", async () => {
    expect(await resolveSessionStatus(client({ ...completed, error: { name: "aborted" } }), "s", {})).toMatchObject({ type: "error" });
  });
  it("rechecks active status after reading a previous completion", async () => {
    expect(await resolveSessionStatus(client(completed, { s: { type: "busy" } }), "s", {})).toEqual({ type: "busy" });
  });
  it("uses explicit status without fetching messages", async () => {
    const c = client(completed);
    expect(await resolveSessionStatus(c, "s", { s: { type: "error" } })).toEqual({ type: "error" });
    expect(c.getMessages).not.toHaveBeenCalled();
  });
});
