import { describe, expect, it, vi, afterEach } from "vitest";
import { OpencodeClient, OpencodeHttpError, OpencodeRequestTimeoutError, OpencodeUnreachableError, httpErrorCode } from "../src/opencode/client.js";

describe("OpencodeClient", () => {
  it("sends basic auth and JSON payloads", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "ses_1" }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096/", username: "u", password: "p", fetchImpl });
    await client.createSession("Title");

    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/session");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: "Title" });
  });

  it("sends the prompt as a single text part and nothing else", async () => {
    const bodies: Array<{ url: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      bodies.push({ url: String(url), body: String(init.body) });
      return new Response(null, { status: 204 });
    };

    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });
    await client.sendMessage({ sessionId: "abc", text: "hello world" });

    // The bridge passes the caller's text through unchanged: no profile, no
    // file contents and no history replay is serialized into the prompt body.
    expect(JSON.parse(bodies[0]!.body)).toEqual({ parts: [{ type: "text", text: "hello world" }] });
  });

  it("omits model/agent/system keys that the caller did not supply", async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init = {}) => {
      bodies.push(String(init.body));
      return new Response(null, { status: 204 });
    };

    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });
    await client.sendMessage({ sessionId: "abc", text: "hi" });

    // undefined fields serialize away, so no empty placeholders are sent.
    const parsed = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["parts"]);
  });

  it("uses prompt_async for async messages", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 204 });
    };

    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });
    await client.sendMessage({ sessionId: "abc", text: "hello", async: true });
    expect(calls[0]).toBe("http://localhost:4096/session/abc/prompt_async");
  });

  it("can request provider and model configuration", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });
    await client.listProviders();
    await client.getProviderAuthMethods();
    await client.getConfigProviders();

    expect(calls).toEqual([
      "http://localhost:4096/provider",
      "http://localhost:4096/provider/auth",
      "http://localhost:4096/config/providers"
    ]);
  });
});


describe("httpErrorCode", () => {
  it.each([
    [200, "OPENCODE_HTTP_ERROR"],
    [400, "OPENCODE_HTTP_ERROR"],
    [401, "OPENCODE_AUTH_ERROR"],
    [403, "OPENCODE_AUTH_ERROR"],
    [402, "OPENCODE_QUOTA_EXCEEDED"],
    [429, "OPENCODE_RATE_LIMITED"],
    [500, "OPENCODE_SERVER_ERROR"],
    [503, "OPENCODE_SERVER_ERROR"],
    [599, "OPENCODE_SERVER_ERROR"]
  ])("maps %i to %s", (status, code) => {
    expect(httpErrorCode(status)).toBe(code);
  });

  it("keeps quota distinguishable for every future 4xx", () => {
    // New client statuses default to the generic domain rather than silently
    // claiming a quota or server failure.
    expect(httpErrorCode(418)).toBe("OPENCODE_HTTP_ERROR");
  });
});

describe("bounded OpenCode requests", () => {
  afterEach(() => vi.useRealTimers());
  it.each([0, -1, 0.5, Infinity, NaN, 2147483648])("rejects invalid deadlines: %s", requestTimeoutMs => {
    expect(() => new OpencodeClient({ baseUrl: "http://localhost", requestTimeoutMs })).toThrow(/requestTimeoutMs/);
  });
  it("bounds a fetch that ignores abort and never retries", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const client = new OpencodeClient({ baseUrl: "http://localhost", fetchImpl, requestTimeoutMs: 50 });
    const result = expect(client.listProviders()).rejects.toBeInstanceOf(OpencodeRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(50); await result;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a stalled response body after successful headers", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
    const client = new OpencodeClient({ baseUrl: "http://localhost", fetchImpl, requestTimeoutMs: 50 });
    const result = expect(client.health()).rejects.toMatchObject({ code: "OPENCODE_REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(50); await result;
  });
  it("does not resubmit an async prompt when acknowledgment times out", async () => {
    vi.useFakeTimers(); const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const client = new OpencodeClient({ baseUrl: "http://localhost", fetchImpl, requestTimeoutMs: 50 });
    const result = expect(client.sendMessage({ sessionId: "s", text: "test", async: true })).rejects.toMatchObject({ code: "OPENCODE_REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(50); await result;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("prompt_async");
  });
  it("allows a bounded longer wait for synchronous generation", async () => {
    vi.useFakeTimers(); let resolve!: (response: Response) => void;
    const fetchImpl: typeof fetch = () => new Promise(done => { resolve = done; });
    const client = new OpencodeClient({ baseUrl: "http://localhost", fetchImpl, requestTimeoutMs: 50 });
    const result = client.sendMessage({ sessionId: "s", text: "test" });
    await vi.advanceTimersByTimeAsync(51);
    resolve(new Response(null, { status: 204 })); await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the deadline after successful responses and ordinary errors", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async () => new Response('{"healthy":true}');
    const client = new OpencodeClient({ baseUrl: "http://localhost", fetchImpl });
    expect(await client.health()).toEqual({ healthy: true }); expect(vi.getTimerCount()).toBe(0);
    const failing = new OpencodeClient({ baseUrl: "http://localhost", fetchImpl: async () => { throw new Error("offline"); } });
    await expect(failing.health()).rejects.toThrow("offline"); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("structured HTTP failures", () => {
  it("carries the status code and body on a non-2xx response", async () => {
    const fetchImpl: typeof fetch = async () => new Response("slow down", { status: 429, statusText: "Too Many Requests" });
    const client = new OpencodeClient({ baseUrl: "http://localhost", fetchImpl });
    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    const http = error as OpencodeHttpError;
    expect(http.status).toBe(429);
    expect(http.statusText).toBe("Too Many Requests");
    expect(http.body).toBe("slow down");
  });

  it.each([
    [402, "OPENCODE_QUOTA_EXCEEDED"],
    [429, "OPENCODE_RATE_LIMITED"],
    [401, "OPENCODE_AUTH_ERROR"],
    [403, "OPENCODE_AUTH_ERROR"],
    [500, "OPENCODE_SERVER_ERROR"],
    [503, "OPENCODE_SERVER_ERROR"],
    [400, "OPENCODE_HTTP_ERROR"]
  ])("maps HTTP %i to failure domain %s", async (status, code) => {
    const fetchImpl: typeof fetch = async () => new Response("", { status, statusText: "err" });
    const client = new OpencodeClient({ baseUrl: "http://localhost", fetchImpl });
    const error = (await client.health().catch((e: unknown) => e)) as OpencodeHttpError;
    expect(error.code).toBe(code);
  });

  it("reports an unreachable server as its own domain, not a bare fetch error", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:4096") });
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    const error = (await client.health().catch((e: unknown) => e)) as OpencodeUnreachableError;
    expect(error).toBeInstanceOf(OpencodeUnreachableError);
    expect(error.code).toBe("OPENCODE_UNREACHABLE");
    // The domain, the target and a concrete remedy are all in one message.
    expect(error.message).toContain("http://127.0.0.1:4096");
    expect(error.message).toMatch(/server running|tunnel/i);
    expect(error.status).toBeUndefined();
  });

  it("does not relabel an abort caused by the deadline as unreachable", async () => {
    const fetchImpl: typeof fetch = async (_url, init = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
      });
    const client = new OpencodeClient({ baseUrl: "http://localhost", fetchImpl, requestTimeoutMs: 20 });
    const error = (await client.health().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(OpencodeRequestTimeoutError);
  });

  it("does not treat a body-only quota string as a quota signal", async () => {
    const fetchImpl: typeof fetch = async () => new Response("quota exceeded", { status: 500, statusText: "Internal Server Error" });
    const client = new OpencodeClient({ baseUrl: "http://localhost", fetchImpl });
    const error = (await client.health().catch((e: unknown) => e)) as OpencodeHttpError;
    expect(error.status).toBe(500);
  });
});
