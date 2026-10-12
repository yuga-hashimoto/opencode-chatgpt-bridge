import { describe, expect, it } from "vitest";
import {
  findFreeModel,
  validateLiveFreeModels,
  validateObservedFreeUsage,
  validateFreeModel,
  getFreeModelAliases,
  detectQuotaError,
  isSubmissionOutcomeUnknown,
  isFreeModel
} from "../src/models/registry.js";
import { OpencodeHttpError, OpencodeRequestTimeoutError } from "../src/opencode/client.js";

describe("Free Model Registry", () => {
  it("finds model by alias", () => {
    const model = findFreeModel("mimo-v2.6-flash-free");
    expect(model).toBeDefined();
    expect(model?.modelId).toBe("mimo-v2.6-flash-free");
    expect(model?.provider).toBe("opencode");
  });

  it("finds model by provider/modelId format", () => {
    const model = findFreeModel("opencode/space-bunny-free");
    expect(model).toBeDefined();
    expect(model?.modelId).toBe("space-bunny-free");
  });

  it("returns undefined for unknown model", () => {
    expect(findFreeModel("gpt-4")).toBeUndefined();
    expect(findFreeModel("claude-3-opus")).toBeUndefined();
  });

  it("validates known free model", () => {
    const model = validateFreeModel("mimo-v2.6-flash-free");
    expect(model.modelId).toBe("mimo-v2.6-flash-free");
  });

  it("throws on non-free model", () => {
    expect(() => validateFreeModel("gpt-4")).toThrow(/not in the free-model registry/);
    expect(() => validateFreeModel("claude-3-opus")).toThrow(/not in the free-model registry/);
  });

  it("returns list of aliases", () => {
    const aliases = getFreeModelAliases();
    expect(aliases).toContain("mimo-v2.6-flash-free");
    expect(aliases).toContain("space-bunny-free");
    expect(aliases.length).toBeGreaterThanOrEqual(2);
  });

  it("classifies HTTP 429 as a rate-limit rejection", () => {
    const detected = detectQuotaError(new OpencodeHttpError(429, "Too Many Requests", "/session/s/message", "slow down"));
    expect(detected?.code).toBe("RATE_LIMITED");
    expect(detected?.status).toBe(429);
  });

  it("classifies HTTP 402 as a quota rejection", () => {
    const detected = detectQuotaError(new OpencodeHttpError(402, "Payment Required", "/session/s/message", ""));
    expect(detected?.code).toBe("QUOTA_EXCEEDED");
  });

  it.each([400, 401, 404, 422, 500, 502, 503])("does not classify HTTP %i as a quota rejection", status => {
    expect(detectQuotaError(new OpencodeHttpError(status, "x", "/session/s/message", "rate limit exceeded"))).toBeUndefined();
  });

  it("never classifies from provider-controlled body text on a plain Error", () => {
    expect(detectQuotaError(new Error("429 rate limit quota exceeded"))).toBeUndefined();
    expect(detectQuotaError(new Error("max_tokens exceeded"))).toBeUndefined();
  });

  it("does not classify a deadline as a quota rejection", () => {
    expect(detectQuotaError(new OpencodeRequestTimeoutError("POST", "/session/s/prompt_async", 30000))).toBeUndefined();
  });

  it("treats deadlines, 5xx and transport errors as unknown outcomes", () => {
    expect(isSubmissionOutcomeUnknown(new OpencodeRequestTimeoutError("POST", "/p", 30000))).toBe(true);
    expect(isSubmissionOutcomeUnknown(new OpencodeHttpError(500, "x", "/p", ""))).toBe(true);
    expect(isSubmissionOutcomeUnknown(new OpencodeHttpError(503, "x", "/p", ""))).toBe(true);
    expect(isSubmissionOutcomeUnknown(new Error("socket hang up"))).toBe(true);
  });

  it("does not treat an explicit quota rejection as an unknown outcome", () => {
    expect(isSubmissionOutcomeUnknown(new OpencodeHttpError(429, "Too Many Requests", "/p", ""))).toBe(false);
    expect(isSubmissionOutcomeUnknown(new OpencodeHttpError(400, "Bad Request", "/p", ""))).toBe(false);
  });

  it("isFreeModel returns true for registered models", () => {
    expect(isFreeModel("mimo-v2.6-flash-free")).toBe(true);
    expect(isFreeModel("space-bunny-free")).toBe(true);
    expect(isFreeModel("gpt-4")).toBe(false);
  });
});

describe("live free-only inventory (real OpenCode 1.18.35 /provider shape)", () => {
  const primary = validateFreeModel("mimo-v2.6-flash-free");
  // Shape taken from @opencode-ai/sdk 1.18.35 generated types:
  // cost.cache_read / cost.cache_write are FLAT and REQUIRED to be zero (fail closed); status is OPTIONAL.
  function modelRecord(overrides: Record<string, unknown> = {}) {
    return {
      id: primary.modelId,
      name: "MiMo",
      release_date: "2026-01-01",
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      limit: { context: 200000, output: 8192 },
      options: {},
      ...overrides
    };
  }
  function inventory() {
    return {
      connected: ["opencode"],
      all: [
        { id: "opencode", name: "opencode", env: [], api: undefined, models: { [primary.modelId]: modelRecord() } }
      ],
      default: { [primary.modelId]: primary.modelId }
    };
  }
  it("accepts a connected model whose advertised tariffs are all zero", () => {
    expect(validateLiveFreeModels(inventory(), [primary])).toEqual([primary]);
  });
  it("rejects a model that omits cache_read", () => {
    const data = inventory();
    (data.all[0]!.models[primary.modelId]!.cost as Record<string, unknown>) = { input: 0, output: 0, cache_write: 0 };
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("rejects a model that omits cache_write", () => {
    const data = inventory();
    (data.all[0]!.models[primary.modelId]!.cost as Record<string, unknown>) = { input: 0, output: 0, cache_read: 0 };
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("rejects a model that omits both cache tariffs", () => {
    const data = inventory();
    (data.all[0]!.models[primary.modelId]!.cost as Record<string, unknown>) = { input: 0, output: 0 };
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("accepts a model with no status field at all", () => {
    const data = inventory();
    Reflect.deleteProperty(data.all[0]!.models[primary.modelId]!, "status");
    expect(validateLiveFreeModels(data, [primary])).toEqual([primary]);
  });
  it.each([null, [], {}, { all: [], connected: [] }])("fails closed on missing inventory: %j", data => {
    expect(() => validateLiveFreeModels(data, [primary])).toThrow();
  });
  it.each(["input", "output", "cache_read", "cache_write"])("rejects a nonzero %s tariff", tariff => {
    const data = inventory();
    (data.all[0]!.models[primary.modelId]!.cost as Record<string, unknown>)[tariff] = 0.01;
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("rejects a nonzero context_over_200k tier", () => {
    const data = inventory();
    (data.all[0]!.models[primary.modelId]!.cost as Record<string, unknown>).context_over_200k = { input: 0.5, output: 0, cache_read: 0, cache_write: 0 };
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("accepts a model with an explicit zero context_over_200k tier", () => {
    const data = inventory();
    (data.all[0]!.models[primary.modelId]!.cost as Record<string, unknown>).context_over_200k = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    expect(validateLiveFreeModels(data, [primary])).toEqual([primary]);
  });
  it("rejects a nonzero context_over_200k cache_read", () => {
    const data = inventory();
    (data.all[0]!.models[primary.modelId]!.cost as Record<string, unknown>).context_over_200k = { input: 0, output: 0, cache_read: 0.01, cache_write: 0 };
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("rejects a context_over_200k tier that omits cache tariffs", () => {
    const data = inventory();
    (data.all[0]!.models[primary.modelId]!.cost as Record<string, unknown>).context_over_200k = { input: 0, output: 0 };
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("rejects a model with no advertised cost block", () => {
    const data = inventory();
    Reflect.deleteProperty(data.all[0]!.models[primary.modelId]!, "cost");
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("rejects disconnected providers", () => {
    const data = inventory();
    data.connected = [];
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("rejects deprecated models", () => {
    const data = inventory();
    (data.all[0]!.models[primary.modelId] as Record<string, unknown>).status = "deprecated";
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("rejects ambiguous provider records", () => {
    const data = inventory();
    data.all.push(data.all[0]!);
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("rejects a model record whose id does not match its key", () => {
    const data = inventory();
    (data.all[0]!.models[primary.modelId] as Record<string, unknown>).id = "something-else";
    expect(() => validateLiveFreeModels(data, [primary])).toThrow(/verified zero-cost/);
  });
  it("requires the independent reviewer to be available too", () => {
    expect(() => validateLiveFreeModels(inventory(), [primary, validateFreeModel("space-bunny-free")])).toThrow(/verified zero-cost/);
  });
});

describe("observed zero-cost execution (real AssistantMessage shape)", () => {
  function assistant(overrides: Record<string, unknown> = {}) {
    return {
      info: {
        id: "msg_1",
        sessionID: "ses_1",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parentID: "pr_1",
        modelID: "mimo-v2.6-flash-free",
        providerID: "opencode",
        mode: "build",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
        ...overrides
      },
      parts: [{ type: "text", text: "done" }]
    };
  }
  it("accepts a zero-cost turn on a registered model", () => {
    expect(validateObservedFreeUsage([assistant()])).toEqual({
      assistantMessages: 1,
      observedCost: 0,
      models: ["opencode/mimo-v2.6-flash-free"]
    });
  });
  it("fails closed when there are no assistant messages", () => {
    const user = assistant({ role: "user" });
    expect(() => validateObservedFreeUsage([user])).toThrow(/No assistant messages/);
  });
  it("accepts a mix of user and assistant messages", () => {
    const user = assistant({ role: "user" });
    const result = validateObservedFreeUsage([user, assistant()]);
    expect(result.assistantMessages).toBe(1);
  });
  it("fails closed when a message lacks info", () => {
    expect(() => validateObservedFreeUsage([{ parts: [] }])).toThrow(/lacks info metadata/);
  });
  it("fails closed when info lacks a role", () => {
    const noRole = assistant();
    Reflect.deleteProperty(noRole.info, "role");
    expect(() => validateObservedFreeUsage([noRole])).toThrow(/lacks a role/);
  });
  it("rejects a turn that actually used a paid model", () => {
    expect(() => validateObservedFreeUsage([assistant({ providerID: "anthropic", modelID: "claude-3-opus" })])).toThrow(
      /non-registered model/
    );
  });
  it("rejects a turn that reported a nonzero cost", () => {
    expect(() => validateObservedFreeUsage([assistant({ cost: 0.01 })])).toThrow(/above the free-only budget/);
  });
  it("fails closed when metadata is missing", () => {
    const partial = assistant();
    Reflect.deleteProperty(partial.info, "cost");
    expect(() => validateObservedFreeUsage([partial])).toThrow(/cannot verify zero-cost execution/);
  });
  it("fails closed on a non-array payload", () => {
    expect(() => validateObservedFreeUsage({})).toThrow(/cannot verify observed model cost/);
  });
});
