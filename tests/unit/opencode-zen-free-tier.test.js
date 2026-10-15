import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, nativeFetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  nativeFetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { OpenCodeZenExecutor, OPENCODE_SESSION_RE } from "../../open-sse/executors/opencode-zen.js";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";
import { getModelSupportedFormats } from "../../open-sse/config/providerModels.js";
import { isOpencodeFreeTierModel } from "../../open-sse/providers/models/helpers.js";

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  nativeFetchMock.mockReset();
  nativeFetchMock.mockResolvedValue(new Response(JSON.stringify({ result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", nativeFetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function preparedCredentials(executor, overrides = {}) {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const credentials = {
    apiKey: "oc_sk_test_key",
    rawHeaders: {},
    connectionId: "conn_test",
    ...overrides,
  };
  return executor.prepareRequestCredentials({
    body,
    credentials,
    providerSessionId: "conversation-a",
    clientTool: "test",
  });
}

function headersFor(model, overrides = {}) {
  const executor = new OpenCodeZenExecutor();
  const credentials = preparedCredentials(executor, overrides);
  return executor.buildHeaders(credentials, true, "https://opencode.ai/zen/v1/chat/completions", model);
}

describe("isOpencodeFreeTierModel", () => {
  it("detects free-tier model ids", () => {
    for (const model of [
      "mimo-v2.6-flash-free",
      "muse-spark-1.3-contributor-free",
      "big-pickle",
      "big-pickle-free",
      "deepseek-v4-flash-free",
      "jev-1.13-free",
    ]) {
      expect(isOpencodeFreeTierModel(model)).toBe(true);
    }
  });

  it("does not misclassify paid models", () => {
    for (const model of ["muse-spark-1.3", "gpt-5.5", "claude-opus-5", "kimi-k3"]) {
      expect(isOpencodeFreeTierModel(model)).toBe(false);
    }
  });

  it("strips thinking suffixes and provider prefixes before matching", () => {
    expect(isOpencodeFreeTierModel("mimo-v2.6-flash-free(xhigh)")).toBe(true);
    expect(isOpencodeFreeTierModel("muse-spark-1.3-contributor-free(1m)")).toBe(true);
    expect(isOpencodeFreeTierModel("ocfree/mimo-v2.6-flash-free")).toBe(true);
    expect(isOpencodeFreeTierModel("big-pickle(max)")).toBe(true);
    expect(isOpencodeFreeTierModel("kimi-k3(max)")).toBe(false);
    expect(isOpencodeFreeTierModel("")).toBe(false);
    expect(isOpencodeFreeTierModel(null)).toBe(false);
  });

  it("recognizes Responses-only model families after a provider namespace", () => {
    const formats = getModelSupportedFormats("ocz", "ocz/muse-spark-1.3-contributor-free");
    expect(formats).toContain("openai-responses");
  });
});

describe("OpenCode Zen free-tier routing and v2 fingerprint", () => {
  it("routes free models to inference while preserving paid Zen routes", () => {
    const executor = new OpenCodeZenExecutor();

    expect(executor.buildUrl("mimo-v2.6-flash-free", true)).toBe(
      "https://opencode.ai/inference/v1/chat/completions",
    );
    expect(executor.buildUrl("muse-spark-1.3-contributor-free", true)).toBe(
      "https://opencode.ai/inference/v1/responses",
    );
    expect(executor.buildUrl("big-pickle", true)).toBe(
      "https://opencode.ai/inference/v1/chat/completions",
    );
    expect(executor.buildUrl("kimi-k3", true)).toBe(
      "https://opencode.ai/zen/v1/chat/completions",
    );
    expect(executor.buildUrl("muse-spark-1.3", true)).toBe(
      "https://opencode.ai/zen/v1/responses",
    );
  });

  it("uses Bearer public and v2 session headers for free-tier chat requests", () => {
    const headers = headersFor("mimo-v2.6-flash-free", {
      rawHeaders: { "x-opencode-request": "msg_0ae8d9cd3001swxaFbM248jcIF" },
      // Simulate a downstream/runtime header overlay so this test verifies
      // that free-tier requests actively remove legacy v1-only headers.
      runtimeTransport: {
        headers: {
          "x-api-key": "legacy-api-key",
          "x-opencode-request": "msg_legacy_request_id",
        },
      },
    });

    expect(headers.Authorization).toBe("Bearer public");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["x-opencode-request"]).toBeUndefined();
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-session-affinity"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["User-Agent"]).toBe("opencode/latest/2.0.29/cli");
  });

  it("uses the free-tier auth policy for Responses models too", () => {
    const headers = headersFor("muse-spark-1.3-contributor-free");
    expect(headers.Authorization).toBe("Bearer public");
    expect(headers["x-opencode-request"]).toBeUndefined();
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["User-Agent"]).toBe("opencode/latest/2.0.29/cli");
  });

  it("uses the free-tier auth policy for Big Pickle despite its bare model id", () => {
    const headers = headersFor("big-pickle");
    expect(headers.Authorization).toBe("Bearer public");
    expect(headers["x-opencode-request"]).toBeUndefined();
  });

  it("retains the configured API key and non-free header behavior for paid models", () => {
    const headers = headersFor("kimi-k3", {
      runtimeTransport: { headers: { "x-api-key": "paid-custom-header" } },
    });
    expect(headers.Authorization).toBe("Bearer oc_sk_test_key");
    expect(headers["x-api-key"]).toBe("paid-custom-header");
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
  });

  it("does not let provider overrides restore forbidden free-tier headers", async () => {
    const executor = new OpenCodeZenExecutor();
    await executor.execute({
      model: "mimo-v2.6-flash-free",
      stream: true,
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "oc_sk_test_key", connectionId: "conn_test", rawHeaders: {} },
      providerOverrides: {
        headers: {
          "x-api-key": "override-api-key",
          "X-OpenCode-Request": "msg_legacy_id",
          authorization: "Bearer override-token",
          "X-Debug-Trace": "preserve-me",
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://opencode.ai/inference/v1/chat/completions");
    const headers = options.headers;
    expect(headers.Authorization).toBe("Bearer public");
    for (const [key, value] of Object.entries(headers)) {
      expect(["x-api-key", "x-opencode-request", "authorization"]).not.toContain(key.toLowerCase());
    }
    expect(headers["X-Debug-Trace"]).toBe("preserve-me");
  });

  it("routes and authenticates free Jev System One requests through inference", async () => {
    await handleSystemoneCore({
      modelInfo: { provider: "opencode-zen", model: "jev-1.13-free" },
      body: { model: "jev-1.13-free", state: {}, questions: { q1: "answer this" } },
      credentials: { apiKey: "oc_sk_test_key", rawHeaders: {} },
    });

    expect(nativeFetchMock).toHaveBeenCalledOnce();
    const [url, options] = nativeFetchMock.mock.calls[0];
    expect(url).toBe("https://opencode.ai/inference/v1/systemone");
    expect(options.headers.Authorization).toBe("Bearer public");
    expect(options.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(options.headers["x-opencode-session-id"]).toBe(options.headers["x-opencode-session"]);
    expect(options.headers["x-session-affinity"]).toBe(options.headers["x-opencode-session"]);
    expect(options.headers["x-session-id"]).toBe(options.headers["x-opencode-session"]);
  });

  it("keeps paid Jev System One requests on Zen with the configured key", async () => {
    await handleSystemoneCore({
      modelInfo: { provider: "opencode-zen", model: "jev-1.13" },
      body: { model: "jev-1.13", state: {}, questions: { q1: "answer this" } },
      credentials: { apiKey: "oc_sk_paid_test_key", rawHeaders: {} },
    });

    expect(nativeFetchMock).toHaveBeenCalledOnce();
    const [url, options] = nativeFetchMock.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/v1/systemone");
    expect(options.headers.Authorization).toBe("Bearer oc_sk_paid_test_key");
  });

  it("injects fingerprint read/shell tools into chat and Responses payloads", () => {
    const executor = new OpenCodeZenExecutor();
    const chat = executor.transformRequest("mimo-v2.6-flash-free", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chat.tools.map((tool) => tool.function?.name)).toEqual(["read", "shell"]);
    expect(chat.tools[0].function.parameters.required).toEqual(["path"]);

    const responses = executor.transformRequest("muse-spark-1.3-contributor-free", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(responses.tools.map((tool) => tool.name)).toEqual(["read", "shell"]);
    expect(responses.tools[0].parameters.required).toEqual(["path"]);
  });
});
