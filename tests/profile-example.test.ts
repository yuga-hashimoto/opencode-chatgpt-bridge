import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { IADevProfileSchema, PathsSchema } from "../src/config/schema.js";
import { validateReadAccess, validateWriteAccess } from "../src/security/profile.js";
import type { IADevProfile } from "../src/config/schema.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The shipped example is copy-pasted verbatim by anyone reusing IA DEV in a new
 * repository. If it drifts from the schema, every new repo breaks on its first
 * profile load, so the example is treated as part of the contract.
 */
describe(".ia-dev.yml.example", () => {
  const profile = IADevProfileSchema.parse(
    parseYaml(readFileSync(join(root, ".ia-dev.yml.example"), "utf8"))
  ) as IADevProfile;

  it("parses against the profile schema", () => {
    expect(profile.version).toBe("2.1");
    expect(profile.goal.length).toBeGreaterThan(0);
  });

  it("requires two different models", () => {
    // ModelSchema refines author !== reviewer, so an equal pair fails to parse.
    const data = parseYaml(readFileSync(join(root, ".ia-dev.yml.example"), "utf8")) as {
      models: { author: string; reviewer: string };
    };
    expect(data.models.author).not.toBe(data.models.reviewer);
    expect(IADevProfileSchema.safeParse({ ...toPlain(), models: { author: "m", reviewer: "m" } }).success).toBe(false);
  });

  it("declares an enforceable 4-list path model", () => {
    const paths = PathsSchema.parse(profile.paths);
    expect(paths.context_paths.length).toBeGreaterThan(0);
    expect(paths.write_paths.length).toBeGreaterThan(0);
    expect(paths.sensitive_paths.length).toBeGreaterThan(0);
    expect(paths.protected_paths).toContain(".ia-dev.yml");
  });

  it("denies writes to sensitive, protected and out-of-scope paths", () => {
    for (const target of [
      ".env",
      "src/auth/.env.local",
      "src/secrets/prod.json",
      ".github/workflows/ci.yml",
      ".ia-dev.yml",
      "src/types/api.d.ts",
      "../../etc/passwd",
      "/etc/passwd"
    ]) {
      expect(validateWriteAccess(profile, target), `${target} must not be writable`).toBe(false);
    }
  });

  it("keeps secrets unreadable even where context_paths is broad", () => {
    expect(validateReadAccess(profile, ".env")).toBe(false);
    expect(validateReadAccess(profile, "src/secrets/token.pem")).toBe(false);
  });
});

/** The example rendered as a plain object, for targeted schema checks. */
function toPlain(): Record<string, unknown> {
  return parseYaml(readFileSync(join(root, ".ia-dev.yml.example"), "utf8")) as Record<string, unknown>;
}
