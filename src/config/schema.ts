import { z } from "zod/v4";

export const PathsSchema = z.object({
  context_paths: z.array(z.string()).default(["**/*"]),
  write_paths: z.array(z.string()).default([]),
  protected_paths: z.array(z.string()).default([
    ".github/**",
    ".ia-dev.yml",
    "package-lock.json",
    "pnpm-lock.yaml",
    "**/*.lock"
  ]),
  sensitive_paths: z.array(z.string()).default([
    "**/.env*",
    "**/*.pem",
    "**/*.key",
    "**/secrets/**",
    "**/credentials/**"
  ])
});

export const ModelSchema = z.object({
  author: z.string().min(1),
  reviewer: z.string().min(1)
}).refine((data) => data.author !== data.reviewer, {
  message: "author and reviewer must be different models",
  path: ["reviewer"]
});

export const LimitsSchema = z.object({
  max_context_tokens: z.number().int().positive().default(4000),
  max_attempts: z.number().int().positive().default(3),
  timeout_ms: z.number().int().positive().default(300000)
});

export const CommandsSchema = z.object({
  build: z.string().optional(),
  test: z.string().optional(),
  lint: z.string().optional(),
  acceptance: z.string().optional()
});

const DEFAULT_PATHS = {
  context_paths: ["**/*"],
  write_paths: [],
  protected_paths: [".github/**", ".ia-dev.yml", "package-lock.json", "pnpm-lock.yaml", "**/*.lock"],
  sensitive_paths: ["**/.env*", "**/*.pem", "**/*.key", "**/secrets/**", "**/credentials/**"]
};

const DEFAULT_LIMITS = {
  max_context_tokens: 4000,
  max_attempts: 3,
  timeout_ms: 300000
};

export const ProfileEnum = z.enum([
  "code-change",
  "bugfix",
  "refactor",
  "test",
  "docs",
  "config"
]);

export const IADevProfileSchema = z.object({
  version: z.literal("2.1"),
  profile: ProfileEnum,
  goal: z.string().min(10),
  paths: PathsSchema.default(DEFAULT_PATHS),
  models: ModelSchema,
  limits: LimitsSchema.default(DEFAULT_LIMITS),
  commands: CommandsSchema.default({})
});

export type IADevProfile = z.infer<typeof IADevProfileSchema>;
export type PathsConfig = z.infer<typeof PathsSchema>;
export type ModelConfig = z.infer<typeof ModelSchema>;
export type LimitsConfig = z.infer<typeof LimitsSchema>;
export type CommandsConfig = z.infer<typeof CommandsSchema>;
export type ProfileType = z.infer<typeof ProfileEnum>;