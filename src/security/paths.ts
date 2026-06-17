import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export type ProjectSummary = {
  name: string;
  path: string;
  isGitRepo: boolean;
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
    throw new Error(`Repo path is outside allowed roots: ${resolvedRepo}`);
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
