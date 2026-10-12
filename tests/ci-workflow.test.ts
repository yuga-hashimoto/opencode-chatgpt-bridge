import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type Step = { uses?: string; with?: Record<string, unknown>; run?: string };

function readWorkflow(): { jobs: Record<string, { steps?: Step[] }> } {
  const raw = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const parsed = parseYaml(raw) as { jobs: Record<string, { steps?: Step[] }> };
  expect(parsed?.jobs, "ci.yml must define jobs").toBeTypeOf("object");
  return parsed;
}

const SHA_RE = /^[0-9a-f]{40}$/;

describe("CI workflow contract", () => {
  it("parses and defines at least one job with steps", () => {
    const wf = readWorkflow();
    const job = Object.values(wf.jobs)[0];
    expect(job?.steps?.length ?? 0).toBeGreaterThan(0);
  });

  it("bootstraps pnpm before any step that caches pnpm", () => {
    const steps = Object.values(readWorkflow().jobs)[0]!.steps!;
    const usesPnpmCache = (s: Step) => s.with?.cache === "pnpm";
    const providesPnpm = (s: Step) =>
      typeof s.uses === "string" && s.uses.startsWith("pnpm/action-setup@")
      || typeof s.run === "string" && s.run.includes("corepack enable");

    const cacheIndex = steps.findIndex(usesPnpmCache);
    if (cacheIndex === -1) return; // no cache configured: nothing to order
    const bootstrapIndex = steps.findIndex(providesPnpm);
    expect(bootstrapIndex, "a pnpm bootstrapping step must precede cache: 'pnpm'").not.toBe(-1);
    expect(bootstrapIndex).toBeLessThan(cacheIndex);
  });

  it("pins every action by full commit SHA", () => {
    const steps = Object.values(readWorkflow().jobs)[0]!.steps!;
    const unpinned = steps
      .filter(s => typeof s.uses === "string")
      .map(s => s.uses!)
      .filter(ref => {
        const sha = ref.split("@")[1] ?? "";
        return !SHA_RE.test(sha);
      });
    expect(unpinned, `actions must be pinned by SHA, found: ${unpinned.join(", ")}`).toEqual([]);
  });

  it("uses the same pnpm version as package.json declares", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      packageManager?: string;
      scripts?: Record<string, string>;
    };
    expect(pkg.packageManager, "package.json must declare packageManager").toMatch(/^pnpm@/);

    const steps = Object.values(readWorkflow().jobs)[0]!.steps!;
    const bootstrap = steps.find(s => typeof s.uses === "string" && s.uses.startsWith("pnpm/action-setup@"));
    if (!bootstrap?.with?.version) return; // version unset: corepack/package.json resolves it
    expect(String(bootstrap.with.version)).toBe(pkg.packageManager!.split("@")[1]);
  });

  it("runs the repository verification scripts in CI", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const runs = Object.values(readWorkflow().jobs)[0]!.steps!
      .map(s => s.run ?? "")
      .join("\n");
    for (const script of ["typecheck", "test", "build"]) {
      expect(pkg.scripts[script], `package.json must define the ${script} script`).toBeTypeOf("string");
      expect(runs).toContain(script);
    }
  });
});
