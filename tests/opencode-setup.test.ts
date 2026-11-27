import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { checkOpencodeCli } from "../src/opencode/setup.js";

describe("checkOpencodeCli", () => {
  it("reports a missing binary as not installed", async () => {
    const config = loadConfig(["--opencode-bin", "/definitely/missing/opencode"]);

    await expect(checkOpencodeCli(config)).resolves.toMatchObject({ installed: false });
  });
});
