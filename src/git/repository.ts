import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { realpath, readFile, lstat, readlink } from "node:fs/promises";

const execFileAsync = promisify(execFile);

type ExecResult = {
  stdout: string;
  stderr: string;
};

async function git(repoPath: string, args: string[]): Promise<ExecResult> {
  const result = await execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function gitRaw(repoPath: string, args: string[]): Promise<ExecResult> {
  const result = await execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function gitNul(repoPath: string, args: string[]): Promise<string[]> {
  const result = await execFileAsync("git", ["-C", repoPath, ...args, "-z"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  return result.stdout.split("\0").filter((s) => s.length > 0);
}

export type GitStatus = {
  repoPath: string;
  topLevel: string;
  branch: string;
  head: string;
  clean: boolean;
  porcelain: string;
  untracked: string[];
  modified: string[];
  staged: string[];
};

export type GitDiff = {
  repoPath: string;
  topLevel: string;
  diff: string;
  stagedDiff: string;
  untracked: Array<{ path: string; readable: boolean; error?: string }>;
  hasChanges: boolean;
};

export type GitRepoInfo = {
  repoPath: string;
  topLevel: string;
  branch: string;
  head: string;
  isMainBranch: boolean;
};

export async function validateGitRepo(repoPath: string): Promise<GitRepoInfo> {
  const resolvedRepo = await realpath(resolve(repoPath));
  const topLevelResult = await git(resolvedRepo, ["rev-parse", "--show-toplevel"]);
  const topLevel = await realpath(resolve(topLevelResult.stdout));

  if (topLevel !== resolvedRepo) {
    throw new Error(`Repository path ${resolvedRepo} does not match Git top-level ${topLevel}`);
  }

  const [branchResult, headResult] = await Promise.all([
    git(resolvedRepo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(resolvedRepo, ["rev-parse", "HEAD"])
  ]);

  const branch = branchResult.stdout;
  const head = headResult.stdout;
  const isMainBranch = branch === "main" || branch === "master";

  return { repoPath: resolvedRepo, topLevel, branch, head, isMainBranch };
}

export async function getGitStatus(repoPath: string): Promise<GitStatus> {
  const info = await validateGitRepo(repoPath);
  const entries = await gitNul(info.topLevel, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]);
  const untracked: string[] = [];
  const modified: string[] = [];
  const staged: string[] = [];
  const display: string[] = [];
  let count = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.startsWith("##")) { display.push(entry); continue; }
    count++;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    display.push(`${status} ${JSON.stringify(file)}`);
    if (status === "??") untracked.push(file);
    else {
      if (status[1] !== " " && status[1] !== "?") modified.push(file);
      if (status[0] !== " " && status[0] !== "?") staged.push(file);
      if (/[RC]/.test(status)) i++; // In -z format destination precedes source.
    }
  }
  const porcelain = display.join("\n");
  const clean = count === 0;

  return {
    repoPath: info.repoPath,
    topLevel: info.topLevel,
    branch: info.branch,
    head: info.head,
    clean,
    porcelain,
    untracked,
    modified,
    staged
  };
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const realRepoPath = await realpath(resolve(repoPath));
  const result = await git(realRepoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.stdout;
}

export async function getHead(repoPath: string): Promise<string> {
  const realRepoPath = await realpath(resolve(repoPath));
  const result = await git(realRepoPath, ["rev-parse", "HEAD"]);
  return result.stdout;
}

export async function getWorktreeTopLevel(repoPath: string): Promise<string> {
  const realRepoPath = await realpath(resolve(repoPath));
  const result = await git(realRepoPath, ["rev-parse", "--show-toplevel"]);
  return await realpath(resolve(result.stdout));
}

export async function getGitDiff(repoPath: string): Promise<GitDiff> {
  const info = await validateGitRepo(repoPath);
  const diffResult = await gitRaw(info.topLevel, ["diff", "--no-color", "--binary", "--no-ext-diff", "--no-textconv"]);
  const diff = diffResult.stdout;
  const hasChanges = diff.length > 0;

  return {
    repoPath: info.repoPath,
    topLevel: info.topLevel,
    diff,
    stagedDiff: "",
    untracked: [],
    hasChanges
  };
}

export async function getGitDiffWithStaged(repoPath: string): Promise<GitDiff> {
  const info = await validateGitRepo(repoPath);
  const diffResult = await gitRaw(info.topLevel, ["diff", "--no-color", "--binary", "--no-ext-diff", "--no-textconv"]);
  const diff = diffResult.stdout;

  const stagedDiffResult = await gitRaw(info.topLevel, ["diff", "--no-color", "--binary", "--no-ext-diff", "--no-textconv", "--staged"]);
  const stagedDiff = stagedDiffResult.stdout;

  const hasChanges = diff.length > 0 || stagedDiff.length > 0;

  return {
    repoPath: info.repoPath,
    topLevel: info.topLevel,
    diff,
    stagedDiff,
    untracked: [],
    hasChanges
  };
}

export async function assertClean(repoPath: string): Promise<void> {
  const status = await getGitStatus(repoPath);
  if (!status.clean) {
    throw new Error(`Repository ${repoPath} has uncommitted changes. Commit or stash them first.`);
  }
}

export async function assertNotMain(repoPath: string): Promise<void> {
  const info = await validateGitRepo(repoPath);
  if (info.isMainBranch) {
    throw new Error(`Cannot modify protected branch '${info.branch}' in ${repoPath}. Create a feature branch first.`);
  }
}

export async function getGitDiffIncludingUntracked(repoPath: string): Promise<GitDiff> {
  const info = await validateGitRepo(repoPath);

  const diffResult = await gitRaw(info.topLevel, ["diff", "--no-color", "--binary", "--no-ext-diff", "--no-textconv"]);
  const diff = diffResult.stdout;

  const stagedDiffResult = await gitRaw(info.topLevel, ["diff", "--no-color", "--binary", "--no-ext-diff", "--no-textconv", "--staged"]);
  const stagedDiff = stagedDiffResult.stdout;

  const untrackedFiles = await gitNul(info.topLevel, ["ls-files", "--others", "--exclude-standard"]);

  const untracked: Array<{ path: string; readable: boolean; error?: string }> = [];

  for (const file of untrackedFiles) {
    const filePath = join(info.topLevel, file);
    try {
      await readFile(filePath, "utf8");
      untracked.push({ path: file, readable: true });
    } catch (error) {
      untracked.push({ path: file, readable: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const hasChanges = diff.length > 0 || stagedDiff.length > 0 || untracked.length > 0;

  return {
    repoPath: info.repoPath,
    topLevel: info.topLevel,
    diff,
    stagedDiff,
    untracked,
    hasChanges
  };
}
export type PathFingerprint = {
  path: string;
  /** sha256 of the worktree content, or null when the file cannot be read. */
  worktree: string | null;
  /** Index state: staged blob hash, or null when the path is not in the index. */
  index: string | null;
  /** lstat mode, used to notice type changes (file <-> symlink). */
  mode: number;
  /** true when the path is absent from the worktree. */
  absent: boolean;
};

export type GitSnapshot = {
  head: string;
  diff: string;
  stagedDiff: string;
  untracked: Array<{ path: string; hash: string; mode: number }>;
  pathFingerprints: PathFingerprint[];
};

async function fingerprintPath(repoPath: string, filePath: string): Promise<PathFingerprint> {
  const absolute = join(repoPath, filePath);
  let worktree: string | null = null;
  let mode = 0;
  let absent = false;
  try {
    const info = await lstat(absolute);
    mode = info.mode;
    const content = info.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    worktree = createHash("sha256").update(content).digest("hex");
  } catch {
    absent = true;
  }
  // --stage is the physical source of truth for what the index holds.
  const stage = await gitNul(repoPath, ["ls-files", "--stage", "--", filePath]);
  const index = stage[0] ? (stage[0].split(/\s+/)[1] ?? null) : null;
  return { path: filePath, worktree, index, mode, absent };
}

/**
 * Fingerprint the given paths through the physical filesystem and the index.
 *
 * This is what lets a caller tell "this path was already dirty before the task"
 * from "the task changed it again": a pre-existing modification that the task
 * leaves untouched keeps an identical fingerprint, while any further edit
 * changes the worktree hash, the index entry, the mode or existence.
 */
export async function capturePathFingerprints(repoPath: string, filePaths: string[]): Promise<PathFingerprint[]> {
  const unique = [...new Set(filePaths)].sort();
  const fingerprints: PathFingerprint[] = [];
  for (const filePath of unique) fingerprints.push(await fingerprintPath(repoPath, filePath));
  return fingerprints;
}

/** Paths whose fingerprint differs between two captures. */
export function changedFingerprints(
  before: readonly PathFingerprint[],
  after: readonly PathFingerprint[]
): string[] {
  const beforeByPath = new Map(before.map(entry => [entry.path, entry]));
  const changed: string[] = [];
  for (const entry of after) {
    const prior = beforeByPath.get(entry.path);
    if (!prior) {
      changed.push(entry.path);
      continue;
    }
    if (
      prior.worktree !== entry.worktree ||
      prior.index !== entry.index ||
      prior.mode !== entry.mode ||
      prior.absent !== entry.absent
    ) {
      changed.push(entry.path);
    }
  }
  return changed.sort();
}

export async function captureGitSnapshot(repoPath: string, diff: GitDiff, head: string): Promise<GitSnapshot> {
  const untracked: GitSnapshot["untracked"] = [];
  for (const file of diff.untracked) {
    if (!file.readable) throw new Error(`Git verification incomplete: ${file.path}: ${file.error}`);
    const path = join(repoPath, file.path);
    const info = await lstat(path);
    const content = info.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path);
    untracked.push({ path: file.path, hash: createHash("sha256").update(content).digest("hex"), mode: info.mode });
  }
  untracked.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const pathFingerprints = await capturePathFingerprints(
    repoPath,
    [...new Set([...diff.untracked.map(file => file.path)])]
  );
  return { head, diff: diff.diff, stagedDiff: diff.stagedDiff, untracked, pathFingerprints };
}
