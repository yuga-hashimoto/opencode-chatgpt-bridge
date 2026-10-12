import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateGitRepo,
  getGitStatus,
  getGitDiff,
  getGitDiffIncludingUntracked,
  getGitDiffWithStaged,
  getCurrentBranch,
  getHead,
  getWorktreeTopLevel,
  assertClean,
  assertNotMain
} from "../src/git/repository.js";

let testRepo: string;
let realTestRepo: string;

async function initGitRepo(path: string) {
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "-b", "main"], { cwd: path, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: path, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: path, encoding: "utf8" });
}

async function gitCommit(path: string, message: string, files: Record<string, string> = {}) {
  const { spawnSync } = await import("node:child_process");
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(path, file), content);
    spawnSync("git", ["add", file], { cwd: path, encoding: "utf8" });
  }
  spawnSync("git", ["commit", "-m", message], { cwd: path, encoding: "utf8" });
}

async function createBranch(path: string, branchName: string) {
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["checkout", "-b", branchName], { cwd: path, encoding: "utf8" });
}

describe("Git Repository - validateGitRepo", () => {
  beforeEach(async () => {
    testRepo = await mkdtemp(join(tmpdir(), "git-test-"));
    realTestRepo = await realpath(testRepo);
    await initGitRepo(testRepo);
    await gitCommit(testRepo, "Initial commit", { "README.md": "# Test Repo" });
  });

  afterEach(async () => {
    await rm(testRepo, { recursive: true, force: true });
  });

  it("validates a proper git repository", async () => {
    const info = await validateGitRepo(testRepo);
    expect(info.repoPath).toBe(realTestRepo);
    expect(info.topLevel).toBe(realTestRepo);
    expect(info.branch).toBe("main");
    expect(info.head).toMatch(/^[a-f0-9]{40}$/);
    expect(info.isMainBranch).toBe(true);
  });

  it("throws if repo path does not match git top-level", async () => {
    const subDir = join(testRepo, "subdir");
    await mkdir(subDir);
    await expect(validateGitRepo(subDir)).rejects.toThrow("does not match Git top-level");
  });

  it("throws for non-git directory", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "non-git-"));
    await writeFile(join(nonGit, "file.txt"), "content");
    await expect(validateGitRepo(nonGit)).rejects.toThrow();
    await rm(nonGit, { recursive: true, force: true });
  });

  it("throws for non-existent path", async () => {
    await expect(validateGitRepo("/non/existent/path")).rejects.toThrow();
  });
});

describe("Git Repository - getGitStatus", () => {
  beforeEach(async () => {
    testRepo = await mkdtemp(join(tmpdir(), "git-status-"));
    realTestRepo = await realpath(testRepo);
    await initGitRepo(testRepo);
    await gitCommit(testRepo, "Initial commit", { "file1.txt": "original" });
  });

  afterEach(async () => {
    await rm(testRepo, { recursive: true, force: true });
  });

  it("returns clean status for clean repo", async () => {
    const status = await getGitStatus(testRepo);
    expect(status.clean).toBe(true);
    expect(status.untracked).toEqual([]);
    expect(status.modified).toEqual([]);
    expect(status.staged).toEqual([]);
    expect(status.porcelain).toContain("## main");
  });

  it("detects unstaged modifications", async () => {
    await writeFile(join(testRepo, "file1.txt"), "modified");
    const status = await getGitStatus(testRepo);
    expect(status.clean).toBe(false);
    expect(status.modified).toContain("file1.txt");
    expect(status.staged).toEqual([]);
  });

  it("detects staged changes", async () => {
    await writeFile(join(testRepo, "file1.txt"), "staged");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["add", "file1.txt"], { cwd: testRepo, encoding: "utf8" });
    const status = await getGitStatus(testRepo);
    expect(status.clean).toBe(false);
    expect(status.staged).toContain("file1.txt");
  });

  it("detects untracked files", async () => {
    await writeFile(join(testRepo, "newfile.txt"), "new");
    const status = await getGitStatus(testRepo);
    expect(status.clean).toBe(false);
    expect(status.untracked).toContain("newfile.txt");
  });

  it("reports staged and unstaged together", async () => {
    await writeFile(join(testRepo, "file1.txt"), "staged change");
    await writeFile(join(testRepo, "file2.txt"), "unstaged change");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["add", "file1.txt"], { cwd: testRepo, encoding: "utf8" });
    const status = await getGitStatus(testRepo);
    expect(status.staged).toContain("file1.txt");
    expect(status.untracked).toContain("file2.txt");
  });
});

describe("Git Repository - getGitDiff", () => {
  beforeEach(async () => {
    testRepo = await mkdtemp(join(tmpdir(), "git-diff-"));
    realTestRepo = await realpath(testRepo);
    await initGitRepo(testRepo);
    await gitCommit(testRepo, "Initial commit", { "file1.txt": "original" });
  });

  afterEach(async () => {
    await rm(testRepo, { recursive: true, force: true });
  });

  it("returns empty diff for clean repo", async () => {
    const diff = await getGitDiff(testRepo);
    expect(diff.diff).toBe("");
    expect(diff.hasChanges).toBe(false);
  });

  it("returns diff for unstaged changes", async () => {
    await writeFile(join(testRepo, "file1.txt"), "modified content");
    const diff = await getGitDiff(testRepo);
    expect(diff.hasChanges).toBe(true);
    expect(diff.diff).toContain("modified content");
  });

  it("does not include staged changes in diff", async () => {
    await writeFile(join(testRepo, "file1.txt"), "staged change");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["add", "file1.txt"], { cwd: testRepo, encoding: "utf8" });
    const diff = await getGitDiff(testRepo);
    expect(diff.hasChanges).toBe(false);
  });
});

describe("Git Repository - getGitDiffIncludingUntracked", () => {
  beforeEach(async () => {
    testRepo = await mkdtemp(join(tmpdir(), "git-diff-untracked-"));
    realTestRepo = await realpath(testRepo);
    await initGitRepo(testRepo);
    await gitCommit(testRepo, "Initial commit", { "file1.txt": "original" });
  });

  afterEach(async () => {
    await rm(testRepo, { recursive: true, force: true });
  });

  it("includes untracked files as separate list", async () => {
    await writeFile(join(testRepo, "newfile.txt"), "new content");
    const diff = await getGitDiffIncludingUntracked(testRepo);
    expect(diff.hasChanges).toBe(true);
    expect(diff.untracked).toHaveLength(1);
    expect(diff.untracked[0]).toEqual({ path: "newfile.txt", readable: true });
    expect(diff.diff).toBe("");
    expect(diff.stagedDiff).toBe("");
  });

  it("includes both unstaged and untracked separately", async () => {
    await writeFile(join(testRepo, "file1.txt"), "modified");
    await writeFile(join(testRepo, "newfile.txt"), "new");
    const diff = await getGitDiffIncludingUntracked(testRepo);
    expect(diff.hasChanges).toBe(true);
    expect(diff.diff).toContain("modified");
    expect(diff.untracked).toHaveLength(1);
    expect(diff.untracked[0]).toEqual({ path: "newfile.txt", readable: true });
  });


  it("lists untracked files in subdirectories", async () => {
    await mkdir(join(testRepo, "subdir"), { recursive: true });
    await writeFile(join(testRepo, "subdir", "nested.txt"), "nested content");
    const diff = await getGitDiffIncludingUntracked(testRepo);
    expect(diff.hasChanges).toBe(true);
    expect(diff.untracked).toHaveLength(1);
    expect(diff.untracked[0]).toEqual({ path: "subdir/nested.txt", readable: true });
  });

  it("handles unicode and special characters in filenames", async () => {
    const specialName = "文件-😀-test.txt";
    await writeFile(join(testRepo, specialName), "unicode content");
    const diff = await getGitDiffIncludingUntracked(testRepo);
    expect(diff.hasChanges).toBe(true);
    expect(diff.untracked).toHaveLength(1);
    expect(diff.untracked[0].path).toBe(specialName);
    expect(diff.untracked[0].readable).toBe(true);
  });

  it("marks untracked as unreadable when read fails", async () => {
    // Create a file and remove read permissions
    const restrictedFile = "restricted.txt";
    await writeFile(join(testRepo, restrictedFile), "secret");
    await import("node:fs/promises").then(fs => fs.chmod(join(testRepo, restrictedFile), 0o000));
    try {
      const diff = await getGitDiffIncludingUntracked(testRepo);
      expect(diff.untracked).toHaveLength(1);
      expect(diff.untracked[0].path).toBe(restrictedFile);
      expect(diff.untracked[0].readable).toBe(false);
      expect(diff.untracked[0].error).toBeDefined();
    } finally {
      // Restore permissions for cleanup
      await import("node:fs/promises").then(fs => fs.chmod(join(testRepo, restrictedFile), 0o644));
    }
  });
});

describe("Git Repository - getGitDiffWithStaged", () => {
  beforeEach(async () => {
    testRepo = await mkdtemp(join(tmpdir(), "git-diff-staged-"));
    realTestRepo = await realpath(testRepo);
    await initGitRepo(testRepo);
    await gitCommit(testRepo, "Initial commit", { "file1.txt": "original" });
  });

  afterEach(async () => {
    await rm(testRepo, { recursive: true, force: true });
  });

  it("returns staged diff when includeUntracked is false", async () => {
    await writeFile(join(testRepo, "file1.txt"), "staged change");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["add", "file1.txt"], { cwd: testRepo, encoding: "utf8" });
    const diff = await getGitDiffWithStaged(testRepo);
    expect(diff.hasChanges).toBe(true);
    expect(diff.stagedDiff).toContain("staged change");
    expect(diff.diff).toBe("");
    expect(diff.untracked).toHaveLength(0);
  });

  it("returns both unstaged and staged diff when includeUntracked is false", async () => {
    // First, add and commit file2.txt so it's tracked
    await writeFile(join(testRepo, "file2.txt"), "original file2");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["add", "file2.txt"], { cwd: testRepo, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "Add file2"], { cwd: testRepo, encoding: "utf8" });

    // Now modify file1.txt (staged) and file2.txt (unstaged)
    await writeFile(join(testRepo, "file1.txt"), "staged change");
    await writeFile(join(testRepo, "file2.txt"), "unstaged change");
    spawnSync("git", ["add", "file1.txt"], { cwd: testRepo, encoding: "utf8" });
    const diff = await getGitDiffWithStaged(testRepo);
    expect(diff.hasChanges).toBe(true);
    expect(diff.stagedDiff).toContain("staged change");
    expect(diff.diff).toContain("unstaged change");
    expect(diff.untracked).toHaveLength(0);
  });
});

describe("Git Repository - branch and head", () => {
  beforeEach(async () => {
    testRepo = await mkdtemp(join(tmpdir(), "git-branch-"));
    realTestRepo = await realpath(testRepo);
    await initGitRepo(testRepo);
    await gitCommit(testRepo, "Initial commit", { "file1.txt": "original" });
  });

  afterEach(async () => {
    await rm(testRepo, { recursive: true, force: true });
  });

  it("getCurrentBranch returns current branch", async () => {
    const branch = await getCurrentBranch(testRepo);
    expect(branch).toBe("main");
  });

  it("getHead returns current commit hash", async () => {
    const head = await getHead(testRepo);
    expect(head).toMatch(/^[a-f0-9]{40}$/);
  });

  it("getWorktreeTopLevel returns repo root", async () => {
    const topLevel = await getWorktreeTopLevel(testRepo);
    expect(topLevel).toBe(realTestRepo);
  });

  it("detects main branch correctly", async () => {
    const info = await validateGitRepo(testRepo);
    expect(info.isMainBranch).toBe(true);
  });

  it("detects non-main branch correctly", async () => {
    await createBranch(testRepo, "feature-branch");
    const info = await validateGitRepo(testRepo);
    expect(info.isMainBranch).toBe(false);
    expect(info.branch).toBe("feature-branch");
  });
});

describe("Git Repository - assertClean", () => {
  beforeEach(async () => {
    testRepo = await mkdtemp(join(tmpdir(), "git-assert-"));
    realTestRepo = await realpath(testRepo);
    await initGitRepo(testRepo);
    await gitCommit(testRepo, "Initial commit", { "file1.txt": "original" });
  });

  afterEach(async () => {
    await rm(testRepo, { recursive: true, force: true });
  });

  it("passes for clean repo", async () => {
    await expect(assertClean(testRepo)).resolves.toBeUndefined();
  });

  it("throws for repo with unstaged changes", async () => {
    await writeFile(join(testRepo, "file1.txt"), "modified");
    await expect(assertClean(testRepo)).rejects.toThrow("uncommitted changes");
  });

  it("throws for repo with staged changes", async () => {
    await writeFile(join(testRepo, "file1.txt"), "staged");
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["add", "file1.txt"], { cwd: testRepo, encoding: "utf8" });
    await expect(assertClean(testRepo)).rejects.toThrow("uncommitted changes");
  });

  it("throws for repo with untracked files", async () => {
    await writeFile(join(testRepo, "newfile.txt"), "new");
    await expect(assertClean(testRepo)).rejects.toThrow("uncommitted changes");
  });
});

describe("Git Repository - assertNotMain", () => {
  beforeEach(async () => {
    testRepo = await mkdtemp(join(tmpdir(), "git-assert-main-"));
    realTestRepo = await realpath(testRepo);
    await initGitRepo(testRepo);
    await gitCommit(testRepo, "Initial commit", { "file1.txt": "original" });
  });

  afterEach(async () => {
    await rm(testRepo, { recursive: true, force: true });
  });

  it("throws on main branch", async () => {
    await expect(assertNotMain(testRepo)).rejects.toThrow("protected branch");
  });

  it("throws on master branch", async () => {
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["branch", "-m", "master"], { cwd: testRepo, encoding: "utf8" });
    await expect(assertNotMain(testRepo)).rejects.toThrow("protected branch");
  });

  it("passes on feature branch", async () => {
    await createBranch(testRepo, "feature-branch");
    await expect(assertNotMain(testRepo)).resolves.toBeUndefined();
  });
});