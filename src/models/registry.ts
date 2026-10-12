import { z } from "zod/v4";
import { OpencodeHttpError, OpencodeRequestTimeoutError } from "../opencode/client.js";

export type FreeModel = {
  provider: string;
  modelId: string;
  alias: string;
  description?: string;
};

export const FREE_MODELS: FreeModel[] = [
  {
    provider: "opencode",
    modelId: "mimo-v2.6-flash-free",
    alias: "mimo-v2.6-flash-free",
    description: "Fast free model for code generation"
  },
  {
    provider: "opencode",
    modelId: "space-bunny-free",
    alias: "space-bunny-free",
    description: "Free model for code review"
  }
];

export function findFreeModel(identifier: string): FreeModel | undefined {
  const normalized = identifier.toLowerCase();
  return FREE_MODELS.find(
    (m) => m.modelId.toLowerCase() === normalized || m.alias.toLowerCase() === normalized || `${m.provider}/${m.modelId}`.toLowerCase() === normalized
  );
}

export function validateFreeModel(identifier: string): FreeModel {
  const model = findFreeModel(identifier);
  if (!model) {
    const available = FREE_MODELS.map((m) => `${m.provider}/${m.modelId} (alias: ${m.alias})`).join(", ");
    throw new Error(`Model "${identifier}" is not in the free-model registry. Available: ${available}`);
  }
  return model;
}

export function getFreeModelAliases(): string[] {
  return FREE_MODELS.map((m) => m.alias);
}

export type QuotaErrorCode = "QUOTA_EXCEEDED" | "RATE_LIMITED";

export class QuotaError extends Error {
  public readonly code: QuotaErrorCode;
  public readonly status: number;

  constructor(message: string, code: QuotaErrorCode, status: number) {
    super(message);
    this.name = "QuotaError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Classify a rejected submission from the structured HTTP status only.
 *
 * The response body is provider-controlled free text, so it is never used to
 * decide whether a prompt may be retried: a 500 whose body happens to say
 * "rate limit" must not be treated as a safe-to-retry quota rejection.
 */
export function detectQuotaError(error: unknown): QuotaError | undefined {
  if (!(error instanceof OpencodeHttpError)) return undefined;
  if (error.status === 429) return new QuotaError(error.message, "RATE_LIMITED", 429);
  if (error.status === 402) return new QuotaError(error.message, "QUOTA_EXCEEDED", 402);
  return undefined;
}

/**
 * True when the outcome of a mutation is unknown: a deadline, a transport
 * error or any 5xx that is not an explicit quota rejection. Callers must not
 * resubmit a prompt in this state.
 */
export function isSubmissionOutcomeUnknown(error: unknown): boolean {
  if (error instanceof OpencodeRequestTimeoutError) return true;
  if (error instanceof OpencodeHttpError) return error.status >= 500;
  return error instanceof Error;
}

export function isFreeModel(identifier: string): boolean {
  return findFreeModel(identifier) !== undefined;
}

// Mirrors OpenCode 1.18.35 GET /provider (verified against @opencode-ai/sdk 1.18.35
// generated types). `cost` is optional on the wire; `cache_read`/`cache_write` are
// flat and must be explicitly zero (fail closed if absent); `status` is optional;
// extra keys are ignored by zod.
const ProviderInventorySchema = z.object({
  connected: z.array(z.string()),
  all: z.array(z.object({ id: z.string(), models: z.record(z.string(), z.unknown()) }))
});

// Fail closed: cache_read/cache_write must be explicitly advertised as 0.
// Absence is not proof of zero cost; it means the provider does not report
// a tariff we can verify. context_over_200k is optional because it only
// applies to models whose context limit exceeds 200k; when present, all
// its rates must also be explicitly zero.
const ZeroRateSchema = z.object({
  input: z.literal(0),
  output: z.literal(0),
  cache_read: z.literal(0),
  cache_write: z.literal(0),
  context_over_200k: z
    .object({
      input: z.literal(0),
      output: z.literal(0),
      cache_read: z.literal(0),
      cache_write: z.literal(0)
    })
    .optional()
});

// `cost` absent => no advertised tariff => cannot be proven free => rejected.
// Every rate the provider advertises must be exactly zero, including cache
// reads and writes; absence of a cache rate is treated as unverifiable, not free.
const ZeroCostModelSchema = z.object({
  id: z.string(),
  cost: ZeroRateSchema,
  status: z.enum(["active", "alpha", "beta", "deprecated"]).optional()
});

export type LiveModelCheck = { ok: true } | { ok: false; reason: string };

function checkAdvertisedZeroCost(raw: unknown): LiveModelCheck {
  const parsed = ZeroCostModelSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "no advertised zero-cost tariff block" };
  if (parsed.data.status === "deprecated") return { ok: false, reason: "model is deprecated" };
  return { ok: true };
}

/** Validate currently advertised tariffs. This is preflight metadata, not observed spend. */
export function validateLiveFreeModels(inventory: unknown, required: FreeModel[]): FreeModel[] {
  const parsed = ProviderInventorySchema.safeParse(inventory);
  if (!parsed.success) throw new Error("Invalid OpenCode provider inventory; refusing unverified model costs.");
  const available = FREE_MODELS.filter(model => {
    if (!parsed.data.connected.includes(model.provider)) return false;
    const providers = parsed.data.all.filter(provider => provider.id === model.provider);
    if (providers.length !== 1) return false;
    const advertised = providers[0]!.models[model.modelId];
    if (advertised === undefined) return false;
    const record = advertised as { id?: unknown };
    if (record.id !== model.modelId) return false;
    return checkAdvertisedZeroCost(advertised).ok;
  });
  for (const model of required) {
    if (!available.some(candidate => candidate.provider === model.provider && candidate.modelId === model.modelId)) {
      throw new Error(`Model ${model.provider}/${model.modelId} is not connected and verified zero-cost.`);
    }
  }
  return available;
}

// Verified against @opencode-ai/sdk 1.18.35 AssistantMessage: every assistant turn
// records the provider/model actually used plus the observed cost.
const ObservedAssistantSchema = z.object({
  role: z.literal("assistant"),
  providerID: z.string(),
  modelID: z.string(),
  cost: z.number()
});

export type ObservedUsageReport = {
  assistantMessages: number;
  observedCost: number;
  models: string[];
};

/**
 * Post-hoc check of what actually ran, using the model/provider/cost recorded on
 * assistant messages. Fails closed when a turn used a model outside the registry
 * or reported a nonzero cost.
 */
export function validateObservedFreeUsage(messages: unknown): ObservedUsageReport {
  if (!Array.isArray(messages)) throw new Error("Unexpected message payload; cannot verify observed model cost.");
  const report: ObservedUsageReport = { assistantMessages: 0, observedCost: 0, models: [] };
  for (const message of messages) {
    const info = (message as { info?: unknown })?.info;
    if (typeof info !== "object" || info === null) {
      throw new Error("Message lacks info metadata; cannot verify observed model cost.");
    }
    const role = (info as { role?: unknown }).role;
    if (typeof role !== "string") {
      throw new Error("Message lacks a role; cannot verify observed model cost.");
    }
    if (role !== "assistant") continue;
    const parsed = ObservedAssistantSchema.safeParse(info);
    if (!parsed.success) throw new Error("Assistant message lacks provider/model/cost metadata; cannot verify zero-cost execution.");
    const { providerID, modelID, cost } = parsed.data;
    if (!findFreeModel(`${providerID}/${modelID}`)) {
      throw new Error(`Session used non-registered model ${providerID}/${modelID}; free-only execution is not satisfied.`);
    }
    report.assistantMessages += 1;
    report.observedCost += cost;
    const label = `${providerID}/${modelID}`;
    if (!report.models.includes(label)) report.models.push(label);
  }
  if (report.assistantMessages === 0) {
    throw new Error("No assistant messages found; cannot verify zero-cost execution.");
  }
  if (report.observedCost > 0) {
    throw new Error(`Session reported cost ${report.observedCost} above the free-only budget of 0.`);
  }
  return report;
}
