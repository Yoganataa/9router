import { describe, expect, it } from "vitest";
import { OpenCodeZenExecutor, OPENCODE_SESSION_RE } from "../../open-sse/executors/opencode-zen.js";
import { isOpencodeFreeTierModel } from "../../open-sse/providers/models/helpers.js";

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
      "big-pickle-free",
      "deepseek-v4-flash-free",
      "jev-1.13-free",
    ]) {
      expect(isOpencodeFreeTierModel(model)).toBe(true);
    }
  });

  it("does not misclassify paid models", () => {
    for (const model of ["big-pickle", "muse-spark-1.3", "gpt-5.5", "claude-opus-5", "kimi-k3"]) {
      expect(isOpencodeFreeTierModel(model)).toBe(false);
    }
  });

  it("strips thinking suffixes and provider prefixes before matching", () => {
    expect(isOpencodeFreeTierModel("mimo-v2.6-flash-free(xhigh)")).toBe(true);
    expect(isOpencodeFreeTierModel("muse-spark-1.3-contributor-free(1m)")).toBe(true);
    expect(isOpencodeFreeTierModel("ocfree/mimo-v2.6-flash-free")).toBe(true);
    expect(isOpencodeFreeTierModel("big-pickle(max)")).toBe(false);
    expect(isOpencodeFreeTierModel("")).toBe(false);
    expect(isOpencodeFreeTierModel(null)).toBe(false);
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
      "https://opencode.ai/zen/v1/chat/completions",
    );
    expect(executor.buildUrl("muse-spark-1.3", true)).toBe(
      "https://opencode.ai/zen/v1/responses",
    );
  });

  it("uses Bearer public and v2 session headers for free-tier chat requests", () => {
    const headers = headersFor("mimo-v2.6-flash-free", {
      rawHeaders: { "x-opencode-request": "msg_0ae8d9cd3001swxaFbM248jcIF" },
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

  it("retains the configured API key for paid models", () => {
    const headers = headersFor("big-pickle");
    expect(headers.Authorization).toBe("Bearer oc_sk_test_key");
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
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
