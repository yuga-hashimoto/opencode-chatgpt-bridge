import { access, readdir, realpath, stat, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { loadProfile, normalizeRelPath, validateReadAccess, validateWriteAccess as profileValidateWriteAccess } from "./profile.js";
import type { IADevProfile } from "../config/schema.js";

export type ProjectSummary = {
  name: string;
  path: string;
  isGitRepo: boolean;
};

export type AccessValidationResult = {
  allowed: boolean;
  deniedPaths: string[];
};

export async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new Error(`Directory does not exist: ${path}`);
  }
}

export async function resolveExistingPath(path: string): Promise<string> {
  await access(path, constants.R_OK);
  return await realpath(path);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel));
}

export async function validateRepoPath(repoPath: string, allowedRoots: string[]): Promise<string> {
  const resolvedRepo = await resolveExistingPath(resolve(repoPath));
  await assertDirectory(resolvedRepo);

  const realRoots = await Promise.all(
    allowedRoots.map(async (root) => {
      try {
        return await resolveExistingPath(resolve(root));
      } catch {
        return null;
      }
    })
  );
  const allowed = realRoots.filter((root): root is string => Boolean(root));
  if (!allowed.some((root) => isInside(root, resolvedRepo))) {
    const configured = allowedRoots.length > 0 ? allowedRoots.join(", ") : "(none configured)";
    throw new Error(
      `Repo path is outside allowed roots: ${resolvedRepo}. ` +
      `Configured allowed roots: ${configured}. ` +
      `Add it with --allowed-roots or the OPENCODE_BRIDGE_ALLOWED_ROOTS environment variable ` +
      `(colon-separated).`
    );
  }
  return resolvedRepo;
}

export async function isGitRepo(path: string): Promise<boolean> {
  const gitDir = join(path, ".git");
  const info = await stat(gitDir).catch(() => null);
  return Boolean(info && info.isDirectory());
}

export async function listProjects(allowedRoots: string[], depth = 2): Promise<ProjectSummary[]> {
  const projects = new Map<string, ProjectSummary>();

  async function walk(dir: string, remainingDepth: number): Promise<void> {
    const realDir = await realpath(dir).catch(() => null);
    if (!realDir) return;
    if (await isGitRepo(realDir)) {
      projects.set(realDir, { name: basename(realDir), path: realDir, isGitRepo: true });
      return;
    }
    if (remainingDepth <= 0) return;
    const entries = await readdir(realDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
        .map((entry) => walk(join(realDir, entry.name), remainingDepth - 1))
    );
  }

  await Promise.all(allowedRoots.map((root) => walk(root, depth)));
  return [...projects.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reject symlink components without reading their targets.
 *
 * `mode` separates the two semantics that used to be conflated:
 * - "read": a path that does not exist is NOT readable, so ENOENT fails closed.
 * - "proposed-write": a missing final path is legitimate, because creating a new
 *   file is the point; only a missing *intermediate* directory is allowed too,
 *   so the caller can create nested files.
 *
 * Filesystem errors other than ENOENT fail closed. This is a preflight check
 * with a TOCTOU window: it runs in the bridge process while the actual read is
 * performed by the OpenCode server, so it is not a sandbox.
 */
export async function isSafeRepoFilePath(
  repoPath: string,
  filePath: string,
  mode: "read" | "proposed-write" = "proposed-write"
): Promise<boolean> {
  let current: string;
  try { current = await realpath(repoPath); } catch { return false; }
  const normalized = normalizeRelPath(filePath);
  const segments = normalized.split("/");
  if (normalized === "." || isAbsolute(normalized) || segments.includes("..") || normalized.includes("\0")) return false;
  if (segments.length === 0 || segments.some(segment => segment.length === 0)) return false;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!);
    const isLast = index === segments.length - 1;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return false;
      if (!isLast && !info.isDirectory()) return false;
      if (isLast && mode === "read" && !info.isFile()) return false;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      // ENOENT: an unreadable path fails closed; a not-yet-created path is a
      // legitimate write target.
      return code === "ENOENT" && mode === "proposed-write";
    }
  }
  return true;
}

export async function validateContextAccess(repoPath: string, filePaths: string[]): Promise<AccessValidationResult> {
  const profile = await loadProfile(repoPath);
  const decisions = await Promise.all(
    filePaths.map(async p => validateReadAccess(profile, p) && (await isSafeRepoFilePath(repoPath, p, "read")))
  );
  const deniedPaths = filePaths.filter((_p, index) => !decisions[index]);
  return {
    allowed: deniedPaths.length === 0,
    deniedPaths
  };
}

export async function validateWriteAccess(repoPath: string, filePaths: string[]): Promise<AccessValidationResult> {
  const profile = await loadProfile(repoPath);
  const decisions = await Promise.all(
    filePaths.map(async p => profileValidateWriteAccess(profile, p) && (await isSafeRepoFilePath(repoPath, p, "proposed-write")))
  );
  const deniedPaths = filePaths.filter((_p, index) => !decisions[index]);
  return {
    allowed: deniedPaths.length === 0,
    deniedPaths
  };
}

export async function getProfilePaths(repoPath: string): Promise<{
  context_paths: string[];
  write_paths: string[];
  protected_paths: string[];
  sensitive_paths: string[];
}> {
  const profile = await loadProfile(repoPath);
  return {
    context_paths: profile.paths.context_paths,
    write_paths: profile.paths.write_paths,
    protected_paths: profile.paths.protected_paths,
    sensitive_paths: profile.paths.sensitive_paths
  };
}

export async function validateProfileExists(repoPath: string): Promise<IADevProfile> {
  return await loadProfile(repoPath);
}
