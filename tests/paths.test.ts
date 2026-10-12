import { mkdtemp, mkdir, realpath, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { validateWriteAccess as profileValidateWriteAccess } from "../src/security/profile.js";

import { listProjects, validateRepoPath, validateContextAccess, validateWriteAccess, validateProfileExists } from "../src/security/paths.js";

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

  async function rejectionMessage(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected the call to be rejected, but it resolved");
  }

  it("explains which roots are configured and how to add one", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const outside = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    const message = await rejectionMessage(() => validateRepoPath(outside, [root]));
    // The denial states the denied path, the configured roots and the
    // remediation, so the failure is actionable instead of a bare rejection.
    expect(message).toMatch(/outside allowed roots/);
    expect(message).toContain(root);
    expect(message).toContain("OPENCODE_BRIDGE_ALLOWED_ROOTS");
    expect(message).toContain("--allowed-roots");
  });

  it("reports an empty root list instead of failing opaquely", async () => {
    const outside = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    const message = await rejectionMessage(() => validateRepoPath(outside, []));
    expect(message).toMatch(/outside allowed roots/);
    expect(message).toContain("none configured");
  });

  it("finds git projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    await mkdir(join(root, "a", ".git"), { recursive: true });
    const projects = await listProjects([root], 2);
    expect(projects.map((p) => p.name)).toContain("a");
  });
});

describe("4-list permission model", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ia-perm-"));
    await mkdir(join(repo, ".git"), { recursive: true });
    // Create .ia-dev.yml with test profile
    await writeFile(join(repo, ".ia-dev.yml"), `
version: "2.1"
profile: "code-change"
goal: "Test permission model with various paths"
paths:
  context_paths:
    - "src/**/*"
    - "tests/**/*"
    - "package.json"
  write_paths:
    - "src/routes/**/*"
    - "tests/**/*"
  protected_paths:
    - ".github/**"
    - "package-lock.json"
  sensitive_paths:
    - "**/.env*"
    - "**/*.key"
models:
  author: "mimo-v2.6-flash-free"
  reviewer: "space-bunny-free"
`);
    // Read validation now fails closed on missing files, so the fixtures the
    // read tests rely on must exist on disk.
    await mkdir(join(repo, "src/routes"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await mkdir(join(repo, "config/secrets"), { recursive: true });
    for (const file of [
      "src/routes/createRoute.ts",
      "tests/unit.test.ts",
      "tests/auth.test.ts",
      "package.json",
      ".env.production",
      "config/secrets/key.pem",
      "src/routes/allowed.ts",
      "src/routes/protected.ts"
    ]) {
      await writeFile(join(repo, file), "synthetic fixture only");
    }
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it.each(["file", "directory", "dangling", "internal"])("rejects %s symlinks for reads and writes", async kind => {
    await mkdir(join(repo, "src/routes"), { recursive: true });
    await writeFile(join(repo, ".env.fixture"), "synthetic fixture only");
    const alias = "src/routes/alias.ts";
    const target = kind === "dangling" ? join(repo, "missing") : kind === "directory" ? repo : kind === "internal" ? join(repo, "src/routes/target.ts") : join(repo, ".env.fixture");
    if (kind === "internal") await writeFile(target, "ordinary fixture");
    await symlink(target, join(repo, alias));
    const filePath = kind === "directory" ? `${alias}/child.ts` : alias;
    expect((await validateContextAccess(repo, [filePath])).deniedPaths).toEqual([filePath]);
    expect((await validateWriteAccess(repo, [filePath])).deniedPaths).toEqual([filePath]);
  });

  it("rejects links to an external synthetic directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ia-symlink-fixture-"));
    try {
      await mkdir(join(repo, "src/routes"), { recursive: true });
      await symlink(outside, join(repo, "src/routes/external"));
      const filePath = "src/routes/external/new.ts";
      expect((await validateContextAccess(repo, [filePath])).allowed).toBe(false);
      expect((await validateWriteAccess(repo, [filePath])).allowed).toBe(false);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("does not report a missing file as readable", async () => {
    const missing = "src/routes/never-created.ts";
    expect((await validateContextAccess(repo, [missing])).deniedPaths).toEqual([missing]);
    // The same path is a legitimate write target.
    expect((await validateWriteAccess(repo, [missing])).allowed).toBe(true);
  });

  it("does not report a directory as readable", async () => {
    expect((await validateContextAccess(repo, ["src/routes"])).deniedPaths).toEqual(["src/routes"]);
  });

  it("allows ordinary existing files and creation under ordinary directories", async () => {
    await mkdir(join(repo, "src/routes"), { recursive: true });
    await writeFile(join(repo, "src/routes/file.ts"), "fixture");
    expect((await validateContextAccess(repo, ["src/routes/file.ts"])).allowed).toBe(true);
    expect((await validateWriteAccess(repo, ["src/routes/new/created.ts"])).allowed).toBe(true);
  });

  it("loads profile successfully", async () => {
    const profile = await validateProfileExists(repo);
    expect(profile.version).toBe("2.1");
    expect(profile.profile).toBe("code-change");
    expect(profile.paths.context_paths).toContain("src/**/*");
    expect(profile.paths.write_paths).toContain("src/routes/**/*");
  });

  it("allows read in context_paths", async () => {
    const result = await validateContextAccess(repo, [
      "src/routes/createRoute.ts",
      "tests/unit.test.ts",
      "package.json"
    ]);
    expect(result.allowed).toBe(true);
    expect(result.deniedPaths).toEqual([]);
  });

  it("denies read in sensitive_paths", async () => {
    const result = await validateContextAccess(repo, [
      ".env.production",
      "config/secrets/key.pem",
      "src/routes/createRoute.ts"
    ]);
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain(".env.production");
    expect(result.deniedPaths).toContain("config/secrets/key.pem");
    expect(result.deniedPaths).not.toContain("src/routes/createRoute.ts");
  });

  it("denies absolute paths even when they match context patterns", async () => {
    const result = await validateContextAccess(repo, [
      "/etc/passwd",
      "C:\\Windows\\System32\\config\\SAM",
      "src/routes/createRoute.ts"
    ]);
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain("/etc/passwd");
    expect(result.deniedPaths).toContain("C:\\Windows\\System32\\config\\SAM");
    expect(result.deniedPaths).not.toContain("src/routes/createRoute.ts");
  });

  it("denies parent-directory traversal in read and write", async () => {
    const readResult = await validateContextAccess(repo, [
      "../outside/secret.ts",
      "src/../../etc/passwd"
    ]);
    expect(readResult.allowed).toBe(false);
    expect(readResult.deniedPaths).toContain("../outside/secret.ts");
    expect(readResult.deniedPaths).toContain("src/../../etc/passwd");

    const writeResult = await validateWriteAccess(repo, [
      "../outside/file.ts",
      "src/../../outside/file.ts"
    ]);
    expect(writeResult.allowed).toBe(false);
    expect(writeResult.deniedPaths).toContain("../outside/file.ts");
    expect(writeResult.deniedPaths).toContain("src/../../outside/file.ts");
  });

  it("denies write to absolute paths even when write_paths is broad", async () => {
    await writeFile(join(repo, ".ia-dev.yml"), `
version: "2.1"
profile: "code-change"
goal: "Test broad write paths with absolute input"
paths:
  context_paths: ["**/*"]
  write_paths: ["**/*"]
  protected_paths: [".github/**"]
  sensitive_paths: ["**/.env*"]
models:
  author: "mimo-v2.6-flash-free"
  reviewer: "space-bunny-free"
`);
    const result = await validateWriteAccess(repo, [
      "/etc/hosts",
      "../outside.ts",
      "src/routes/createRoute.ts"
    ]);
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain("/etc/hosts");
    expect(result.deniedPaths).toContain("../outside.ts");
    expect(result.deniedPaths).not.toContain("src/routes/createRoute.ts");
  });

  it("allows write in write_paths", async () => {
    const result = await validateWriteAccess(repo, [
      "src/routes/createRoute.ts",
      "tests/auth.test.ts"
    ]);
    expect(result.allowed).toBe(true);
    expect(result.deniedPaths).toEqual([]);
  });

  it("denies write in protected_paths", async () => {
    const result = await validateWriteAccess(repo, [
      ".github/workflows/ci.yml",
      "package-lock.json",
      "src/routes/createRoute.ts"
    ]);
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain(".github/workflows/ci.yml");
    expect(result.deniedPaths).toContain("package-lock.json");
    expect(result.deniedPaths).not.toContain("src/routes/createRoute.ts");
  });

  it.each([
    "src/routes/.env", "src/routes/.env.production", "src/routes/service.key",
    "tests/.env.local", "src/routes/./.env", "src//routes//.env",
    "src\\routes\\service.key"
  ])("denies sensitive writes even inside write_paths: %s", async filePath => {
    const result = await validateWriteAccess(repo, [filePath, "src/routes/allowed.ts"]);
    expect(result.deniedPaths).toEqual([filePath]);
    expect(result.allowed).toBe(false);
  });

  it("applies protected patterns to canonical relative paths", async () => {
    const profile = await validateProfileExists(repo);
    profile.paths.write_paths = ["**/*"];
    profile.paths.protected_paths = ["src/routes/protected.ts"];
    for (const filePath of ["src/routes/protected.ts", "src/./routes/protected.ts", "src//routes//protected.ts", "src/routes/protected.ts/."]) {
      expect(profileValidateWriteAccess(profile, filePath)).toBe(false);
    }
    expect(profileValidateWriteAccess(profile, "src/routes/allowed.ts")).toBe(true);
  });

  it("normalizes benign path variants without broadening permissions", async () => {
    const result = await validateContextAccess(repo, ["./src//routes/./allowed.ts", "src\\routes\\allowed.ts"]);
    expect(result.allowed).toBe(true);
    expect((await validateWriteAccess(repo, ["./src//routes/./allowed.ts"])).allowed).toBe(true);
  });

  it("denies paths containing NUL for both read and write", async () => {
    const filePath = "src/routes/file\0.ts";
    expect((await validateContextAccess(repo, [filePath])).deniedPaths).toEqual([filePath]);
    expect((await validateWriteAccess(repo, [filePath])).deniedPaths).toEqual([filePath]);
  });

  it("denies write outside write_paths", async () => {
    const result = await validateWriteAccess(repo, [
      "src/types/index.ts",
      "docs/readme.md",
      "src/routes/createRoute.ts"
    ]);
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain("src/types/index.ts");
    expect(result.deniedPaths).toContain("docs/readme.md");
    expect(result.deniedPaths).not.toContain("src/routes/createRoute.ts");
  });

  it("empty write_paths denies all writes", async () => {
    // Create a profile with empty write_paths
    await writeFile(join(repo, ".ia-dev.yml"), `
version: "2.1"
profile: "code-change"
goal: "Test empty write paths"
paths:
  context_paths: ["src/**/*"]
  write_paths: []
  protected_paths: [".github/**"]
  sensitive_paths: ["**/.env*"]
models:
  author: "mimo-v2.6-flash-free"
  reviewer: "space-bunny-free"
`);
    const result = await validateWriteAccess(repo, ["src/routes/createRoute.ts"]);
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain("src/routes/createRoute.ts");
  });

  it("rejects profile with same author and reviewer", async () => {
    await writeFile(join(repo, ".ia-dev.yml"), `
version: "2.1"
profile: "code-change"
goal: "Test same models"
paths:
  context_paths: ["**/*"]
  write_paths: ["src/**/*"]
  protected_paths: [".github/**"]
  sensitive_paths: ["**/.env*"]
models:
  author: "mimo-v2.6-flash-free"
  reviewer: "mimo-v2.6-flash-free"
`);
    await expect(validateProfileExists(repo)).rejects.toThrow(/author and reviewer must be different/);
  });

  it("requires version 2.1", async () => {
    await writeFile(join(repo, ".ia-dev.yml"), `
version: "2.0"
profile: "code-change"
goal: "Test version"
paths:
  context_paths: ["**/*"]
  write_paths: ["src/**/*"]
  protected_paths: [".github/**"]
  sensitive_paths: ["**/.env*"]
models:
  author: "mimo-v2.6-flash-free"
  reviewer: "space-bunny-free"
`);
    await expect(validateProfileExists(repo)).rejects.toThrow();
  });

  it("requires goal minimum length", async () => {
    await writeFile(join(repo, ".ia-dev.yml"), `
version: "2.1"
profile: "code-change"
goal: "short"
paths:
  context_paths: ["**/*"]
  write_paths: ["src/**/*"]
  protected_paths: [".github/**"]
  sensitive_paths: ["**/.env*"]
models:
  author: "mimo-v2.6-flash-free"
  reviewer: "space-bunny-free"
`);
    await expect(validateProfileExists(repo)).rejects.toThrow();
  });
});
