import { readFile } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";
import * as yaml from "yaml";
import { minimatch } from "minimatch";
import {
  IADevProfileSchema,
  type IADevProfile
} from "../config/schema.js";
import { validateFreeModel } from "../models/registry.js";

function isRepoRelative(filePath: string): boolean {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) return false;
  if (posix.isAbsolute(filePath) || win32.isAbsolute(filePath)) return false;
  return !filePath.replaceAll("\\", "/").split("/").includes("..");
}

export function normalizeRelPath(filePath: string): string {
  return posix.normalize(filePath.replaceAll("\\", "/")).replace(/\/$/, "");
}

export async function loadProfile(repoPath: string): Promise<IADevProfile> {
  if (typeof repoPath !== "string") {
    throw new TypeError(`loadProfile expects a string repoPath, received ${typeof repoPath}: ${JSON.stringify(repoPath)}`);
  }
  const configPath = resolve(repoPath, ".ia-dev.yml");
  const raw = await readFile(configPath, "utf8").catch(() => null);
  if (!raw) {
    throw new Error(`Missing .ia-dev.yml in ${repoPath}. Create it from .ia-dev.yml.example`);
  }
  const parsed = yaml.parse(raw);
  const profile = IADevProfileSchema.parse(parsed);
  validateFreeModel(profile.models.author);
  validateFreeModel(profile.models.reviewer);
  return profile;
}

export function validateReadAccess(profile: IADevProfile, filePath: string): boolean {
  if (!isRepoRelative(filePath)) return false;
  const normalized = normalizeRelPath(filePath);
  const { context_paths, sensitive_paths } = profile.paths;
  if (matchAny(normalized, sensitive_paths)) return false;
  return matchAny(normalized, context_paths);
}

export function validateWriteAccess(profile: IADevProfile, filePath: string): boolean {
  if (!isRepoRelative(filePath)) return false;
  const normalized = normalizeRelPath(filePath);
  const { write_paths, protected_paths, sensitive_paths } = profile.paths;
  if (matchAny(normalized, protected_paths) || matchAny(normalized, sensitive_paths)) return false;
  if (write_paths.length === 0) return false;
  return matchAny(normalized, write_paths);
}

export function validateContextPaths(profile: IADevProfile, filePaths: string[]): string[] {
  return filePaths.filter((p) => !validateReadAccess(profile, p));
}

export function validateWritePaths(profile: IADevProfile, filePaths: string[]): string[] {
  return filePaths.filter((p) => !validateWriteAccess(profile, p));
}

function matchAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(filePath, pattern, { dot: true }));
}

export function getAllowedContextPaths(profile: IADevProfile): string[] {
  return profile.paths.context_paths;
}

export function getAllowedWritePaths(profile: IADevProfile): string[] {
  return profile.paths.write_paths;
}

export function getProtectedPaths(profile: IADevProfile): string[] {
  return profile.paths.protected_paths;
}

export function getSensitivePaths(profile: IADevProfile): string[] {
  return profile.paths.sensitive_paths;
}

export type { IADevProfile, PathsConfig } from "../config/schema.js";
