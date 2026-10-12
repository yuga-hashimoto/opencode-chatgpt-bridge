import { describe, expect, it } from "vitest";
import { verifyRecoveredSession } from "../src/opencode/recovery.js";

describe("session recovery after server restart", () => {
  it("accepts the original session in the same project", async () => {
    await expect(verifyRecoveredSession({ getSession: async () => ({ id: "s", directory: process.cwd() }) }, "s", process.cwd())).resolves.toBeUndefined();
  });
  it.each([{ id: "other", directory: process.cwd() }, { id: "s", directory: "/private/tmp" }, { id: "s" }])("rejects an unrelated session: %j", async (session) => {
    await expect(verifyRecoveredSession({ getSession: async () => session }, "s", process.cwd())).rejects.toThrow("does not match");
  });
  it("preserves missing-session errors without rebinding", async () => {
    await expect(verifyRecoveredSession({ getSession: async () => { throw new Error("404"); } }, "s", process.cwd())).rejects.toThrow("404");
  });
});
