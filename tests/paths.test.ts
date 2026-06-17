import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listProjects, validateRepoPath } from "../src/security/paths.js";

describe("path security", () => {
  it("allows paths inside allowed roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await expect(validateRepoPath(repo, [root])).resolves.toBe(await realpath(repo));
  });

  it("rejects paths outside allowed roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const outside = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    await expect(validateRepoPath(outside, [root])).rejects.toThrow(/outside allowed roots/);
  });

  it("finds git projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    await mkdir(join(root, "a", ".git"), { recursive: true });
    const projects = await listProjects([root], 2);
    expect(projects.map((p) => p.name)).toContain("a");
  });
});
