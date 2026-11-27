import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state/store.js";

describe("StateStore", () => {
  it("preserves sessions created concurrently", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "bridge-state-"));
    const store = new StateStore(stateDir);

    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.createSession({
            opencodeSessionId: `session-${index}`,
            repoPath: `/repo/${index}`,
            baseUrl: "http://127.0.0.1:4096"
          })
        )
      );

      expect(await store.listSessions()).toHaveLength(20);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
