import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

const MODEL = "step-5-preview-free";
const REQUEST = {
  model: MODEL,
  body: { model: MODEL, messages: [{ role: "user", content: "Reply with OK" }] },
  stream: true,
  credentials: { connectionId: "opencode-endpoint-retry-test" },
};

function unavailableResponse() {
  return new Response(JSON.stringify({
    error: {
      type: "server_error",
      message: "Upstream request failed: Endpoint is unavailable.",
    },
  }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
}

function okResponse() {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function rateLimitResponse() {
  return new Response(JSON.stringify({
    error: { type: "rate_limit_error", message: "Rate limit exceeded." },
  }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenCode transient endpoint retry", () => {
  it("sets a bounded retry policy for OpenCode 429 responses", () => {
    expect(PROVIDERS.opencode.retry?.[429]).toEqual({ attempts: 5, delayMs: 2000 });
  });

  it("retries Endpoint is unavailable internally and returns a later success", async () => {
    vi.useFakeTimers();
    proxyAwareFetch
      .mockResolvedValueOnce(unavailableResponse())
      .mockResolvedValueOnce(okResponse());

    const pending = new OpenCodeExecutor().execute(REQUEST);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
  });

  it("does not retry an ordinary rate-limit response", async () => {
    proxyAwareFetch.mockResolvedValueOnce(rateLimitResponse());

    const result = await new OpenCodeExecutor().execute(REQUEST);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
    await expect(result.response.json()).resolves.toMatchObject({
      error: { type: "rate_limit_error" },
    });
  });
});
