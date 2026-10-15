import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

const executor = new OpenCodeExecutor();

function unavailable429(headers = {}) {
  return new Response(JSON.stringify({
    error: {
      type: "server_error",
      message: "Upstream request failed: Endpoint is unavailable.",
    },
  }), {
    status: 429,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("OpenCode transient unavailable-gateway retry", () => {
  it("configures four bounded retries with exponential backoff", () => {
    expect(executor.config.retry["429"]).toEqual({ attempts: 4, delayMs: 2000 });
  });

  it("uses the 2s, 4s, 8s, 12s backoff for the exact gateway error", async () => {
    const response = unavailable429();
    expect(await executor.computeRetryDelay(response, 1, 2000)).toBe(2000);
    expect(await executor.computeRetryDelay(response, 2, 2000)).toBe(4000);
    expect(await executor.computeRetryDelay(response, 3, 2000)).toBe(8000);
    expect(await executor.computeRetryDelay(response, 4, 2000)).toBe(12000);
    // The retry hook reads a clone; the original response remains available downstream.
    expect((await response.json()).error.message).toContain("Endpoint is unavailable");
  });

  it("honors retry-after-ms when the server provides it", async () => {
    expect(await executor.computeRetryDelay(unavailable429({ "retry-after-ms": "6500" }), 1, 2000)).toBe(6500);
  });

  it("honors retry-after in seconds", async () => {
    expect(await executor.computeRetryDelay(unavailable429({ "retry-after": "5" }), 1, 2000)).toBe(5000);
  });

  it("does not internally retry a real rate-limit response", async () => {
    const response = new Response(JSON.stringify({
      error: { type: "rate_limit_error", message: "Rate limit exceeded." },
    }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
    expect(await executor.computeRetryDelay(response, 1, 2000)).toBe(false);
  });

  it("does not sleep internally for retry-after values longer than 30 seconds", async () => {
    expect(await executor.computeRetryDelay(unavailable429({ "retry-after": "45" }), 1, 2000)).toBe(false);
  });
});
