import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, nativeFetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  nativeFetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import {
  OPENCODE_SESSION_RE,
  generateSessionId,
  translateSessionId,
  stableSessionId,
} from "../../open-sse/executors/opencode.js";
import {
  OpenCodeZenExecutor,
  generateSessionId as generateZenSessionId,
  translateSessionId as translateZenSessionId,
} from "../../open-sse/executors/opencode-zen.js";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";
import { getModelSupportedFormats } from "../../open-sse/config/providerModels.js";
import { isOpencodeFreeTierModel } from "../../open-sse/providers/models/helpers.js";

function makeCredentials(overrides = {}) {
  return {
    connectionId: "conn_test",
    rawHeaders: {},
    ...overrides,
  };
}

function prepare(executor, overrides = {}) {
  const credentials = overrides.credentials || makeCredentials();
  const prepared = executor.prepareRequestCredentials({
    body: overrides.body || { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
    credentials,
    providerSessionId: overrides.providerSessionId ?? "conversation-a",
    clientTool: overrides.clientTool ?? "claude",
  });
  return { credentials, prepared };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  nativeFetchMock.mockReset();
  nativeFetchMock.mockResolvedValue(new Response(JSON.stringify({
    result: "ok",
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenCode Free Session ID Format", () => {
  it("generates session IDs matching OpenCode canonical format (ses_ + 12 hex + 14 base62)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateSessionId();
      expect(id).toMatch(OPENCODE_SESSION_RE);
      expect(id).toHaveLength(30);
    }
  });

  it("translates arbitrary sessions into valid OpenCode session format", () => {
    const inputs = [
      "claude:550e8400-e29b-41d4-a716-446655440000",
      "antigravity:conv-abc-123",
      "session-from-codex",
      "12345",
      "",
    ];
    for (const raw of inputs) {
      const translated = translateSessionId(raw, "claude");
      expect(translated).toMatch(OPENCODE_SESSION_RE);
      expect(translated).toHaveLength(30);
    }
  });

  // Upstream decodes the prefix as ~(time * 0x1000 + counter) and answers
  // 403 FreeTierError unless the counter is small; hash-filled prefixes failed.
  it("encodes a small counter in session prefixes so the free-tier gate accepts them", () => {
    const counterOf = (id) => Number(~BigInt(`0x${id.slice(4, 16)}`) & 0xfffn);
    for (const translate of [translateSessionId, translateZenSessionId]) {
      for (const raw of ["claude:550e8400-e29b-41d4-a716-446655440000", "session-from-codex", "", "x".repeat(300)]) {
        const translated = translate(raw, "claude");
        expect(translated).toMatch(OPENCODE_SESSION_RE);
        expect(counterOf(translated)).toBe(1);
        expect(translate(raw, "claude")).toBe(translated);
      }
    }
    expect(counterOf(generateSessionId(1_700_000_000_000))).toBeLessThanOrEqual(16);
    expect(counterOf(generateZenSessionId(1_700_000_000_000))).toBe(1);
  });

  it("preserves already-valid OpenCode sessions without re-hashing", () => {
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    expect(translateSessionId(valid)).toBe(valid);
    expect(translateSessionId(`  ${valid}  `)).toBe(valid);
  });
});

describe("OpenCode Free Executor Session Resolution", () => {
  it("uses request-local session credentials without mutating source credentials", () => {
    const executor = getExecutor("opencode");
    const { credentials, prepared } = prepare(executor);

    expect(executor.constructor.name).toBe("OpenCodeExecutor");
    expect(prepared).not.toBe(credentials);
    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(credentials).not.toHaveProperty("_opencodeSession");
    expect(executor).not.toHaveProperty("_currentSessionId");
  });

  it("preserves valid native x-opencode-session header case-insensitively", () => {
    const executor = getExecutor("opencode");
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "X-OpenCode-Session": ` ${valid} ` } }),
    });

    expect(prepared._opencodeSession).toBe(valid);
  });

  it("translates invalid native x-opencode-session header into a valid session", () => {
    const executor = getExecutor("opencode");
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "x-opencode-session": "invalid-session-uuid" } }),
    });

    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(prepared._opencodeSession).not.toBe("invalid-session-uuid");
  });

  it("translates conversation session deterministically", () => {
    const executor = getExecutor("opencode");
    const first = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;
    const second = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;

    expect(first).toBe(second);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("isolates different conversations and tools", () => {
    const executor = getExecutor("opencode");
    const convA = prepare(executor, { providerSessionId: "conversation-a" }).prepared._opencodeSession;
    const convB = prepare(executor, { providerSessionId: "conversation-b" }).prepared._opencodeSession;
    const toolClaude = prepare(executor, { providerSessionId: "same", clientTool: "claude" }).prepared._opencodeSession;
    const toolCodex = prepare(executor, { providerSessionId: "same", clientTool: "codex" }).prepared._opencodeSession;

    expect(convA).not.toBe(convB);
    expect(toolClaude).not.toBe(toolCodex);
  });

  it("adds the valid session header to fetch requests", async () => {
    const executor = getExecutor("opencode");
    const credentials = makeCredentials();
    const result = await executor.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
      stream: false,
      credentials,
      providerSessionId: "conversation-fetch-test",
      clientTool: "claude",
    });

    expect(result.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(result.headers["x-opencode-session"]);
    expect(fetchMock.mock.calls[0][1].headers["Authorization"]).toBe("Bearer public");
    expect(credentials).not.toHaveProperty("_opencodeSession");
  });

  it("falls back to a valid generated session in buildHeaders when called standalone", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({});

    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["Authorization"]).toBe("Bearer public");
  });
  it("handles null or undefined body gracefully in transformRequest", () => {
    const executor = getExecutor("opencode");
    expect(() => executor.transformRequest("muse-spark-1.3-contributor-free", null, false, {})).not.toThrow();
    expect(() => executor.transformRequest("big-pickle", undefined, false, {})).not.toThrow();
  });
});

describe("OpenCode Free User-Agent Validation", () => {
  it("defaults User-Agent to the v2 CLI form for non-opencode downstream clients", () => {
    const executor = getExecutor("opencode");
    const headersNoUa = executor.buildHeaders({});
    expect(headersNoUa["User-Agent"]).toBe("opencode/latest/2.0.29/cli");

    const headersClaude = executor.buildHeaders({ rawHeaders: { "user-agent": "Claude-Code/1.0" } });
    expect(headersClaude["User-Agent"]).toBe("opencode/latest/2.0.29/cli");
  });

  it("replaces v1-style opencode User-Agents, which upstream now rejects with 403", () => {
    const executor = getExecutor("opencode");
    for (const ua of ["opencode", "opencode/1.15.0", "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14"]) {
      expect(executor.buildHeaders({ rawHeaders: { "user-agent": ua } })["User-Agent"]).toBe("opencode/latest/2.0.29/cli");
    }
  });

  it("preserves a v2 opencode downstream User-Agent", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/latest/2.0.29/desktop" } });
    expect(headers["User-Agent"]).toBe("opencode/latest/2.0.29/desktop");
  });

  it("sends the v2 session headers and never x-opencode-request", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({
      rawHeaders: { "x-opencode-request": "msg_0ae8d9cd3001swxaFbM248jcIF" },
    });
    const session = headers["x-opencode-session"];
    expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(session);
    expect(headers["x-session-affinity"]).toBe(session);
    expect(headers["x-session-id"]).toBe(session);
    expect(headers["x-opencode-client"]).toBe("cli");
    expect("x-opencode-request" in headers).toBe(false);
  });
});

describe("OpenCode Stable Session Reuse (429 follow-up)", () => {
  function anonymousCredentials(auth) {
    return makeCredentials({ connectionId: undefined, rawHeaders: { authorization: `Bearer ${auth}` } });
  }

  it("reuses one stable upstream session instead of minting a new one per request", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const first = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });
    const second = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });

    expect(first._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(second._opencodeSession).toBe(first._opencodeSession);
  });

  it("isolates stable sessions by downstream identity", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const forKey = (auth) => executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials(auth),
      providerSessionId: null,
      clientTool: "claude",
    })._opencodeSession;

    expect(forKey("user-A")).not.toBe(forKey("user-B"));
    expect(forKey("user-A")).toMatch(OPENCODE_SESSION_RE);
  });

  it("exposes the stable session helper directly", () => {
    const first = stableSessionId({ connectionId: "direct-conn" });
    expect(stableSessionId({ connectionId: "direct-conn" })).toBe(first);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("keeps the standalone buildHeaders session stable across calls", () => {
    const executor = getExecutor("opencode");
    const first = executor.buildHeaders({})["x-opencode-session"];
    const second = executor.buildHeaders({})["x-opencode-session"];
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(second).toBe(first);
  });

  it("applies the read/shell free-tier fingerprint on Chat Completions", () => {
    const executor = getExecutor("opencode");

    const chatNoTools = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chatNoTools.stream).toBe(true);
    // tool_choice "none" is answered with 403 FreeTierError upstream.
    expect(chatNoTools.tool_choice).toBeUndefined();
    expect(chatNoTools.tools.map((t) => t.function?.name)).toEqual(["read", "shell"]);
    expect(chatNoTools.messages[0].role).toBe("system");

    const chatWithTools = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "Bash", description: "Claude Code tool" } },
        { type: "function", function: { name: "Read", description: "Claude Code tool" } },
      ],
      tool_choice: "auto",
    });
    expect(chatWithTools.tool_choice).toBe("auto");
    expect(chatWithTools.tools.map((t) => t.function?.name)).toEqual(["Bash", "Read", "read", "shell"]);

    const chatClash = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", description: "existing" } }],
    });
    expect(chatClash.tools.map((t) => t.function?.name)).toEqual(["read_client", "read", "shell"]);
    expect(chatClash.tools[0].function.description).toBe("existing");
  });

  it("cloaks Muse Responses requests even when the client already supplies tools", () => {
    const executor = getExecutor("opencode");
    const transformed = executor.transformRequest("muse-spark-1.3-contributor-free(xhigh)", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{
        type: "function",
        name: "zcode_search",
        description: "client-provided tool",
        parameters: { type: "object", properties: {} },
      }],
      tool_choice: "auto",
      reasoning_effort: "xhigh",
    }, true, {});

    expect(transformed.stream).toBe(true);
    expect(transformed.reasoning?.effort).toBe("xhigh");
    expect(transformed.tools.map((tool) => tool.name)).toEqual(["zcode_search", "read", "shell"]);
    expect(transformed.instructions).toMatch(/Do not call the `read` or `shell` tools/);
  });

  it("declares forceStream on the opencode transport so chatCore serves SSE upstream", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS.opencode?.forceStream).toBe(true);
  });
});


describe("OpenCode Zen (opencode-zen) v2 Free-Tier Fingerprint", () => {
  it("sends the v2 CLI User-Agent, client header, and mirrored session headers", () => {
    const executor = getExecutor("opencode-zen");
    const headers = executor.buildHeaders({
      rawHeaders: { "user-agent": "opencode/1.18.31" },
    });
    const session = headers["x-opencode-session"];
    expect(headers["User-Agent"]).toBe("opencode/latest/2.0.29/cli");
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-project"]).toBe("global");
    expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(session);
    expect(headers["x-session-affinity"]).toBe(session);
    expect(headers["x-session-id"]).toBe(session);
  });

  it("applies the verbatim read/shell fingerprint tools and aliases conflicts on opencode-zen", () => {
    const executor = getExecutor("opencode-zen");
    const chat = executor.transformRequest("mimo-v2.6-flash-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", description: "caller read" } }],
    });
    expect(chat.stream).toBe(true);
    expect(chat.tools.map((t) => t.function?.name)).toEqual(["read_client", "read", "shell"]);
    expect(chat.tools[1].function.parameters.required).toEqual(["path"]);
    expect(chat.messages[0].role).toBe("system");

    const responses = executor.transformRequest("muse-spark-1.3-contributor-free", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "custom_search", description: "search", parameters: { type: "object", properties: {} } }],
    });
    expect(responses.stream).toBe(true);
    expect(responses.tools.map((t) => t.name)).toEqual(["custom_search", "read", "shell"]);
    expect(responses.tools[1].parameters.required).toEqual(["path"]);
    expect(responses.instructions).toMatch(/Do not call the `read` or `shell` tools/);
  });
});



function opencodeZenHeadersFor(model, overrides = {}) {
  const executor = new OpenCodeZenExecutor();
  const credentials = executor.prepareRequestCredentials({
    body: { messages: [{ role: "user", content: "hi" }] },
    credentials: {
      apiKey: "oc_sk_test_key",
      rawHeaders: {},
      connectionId: "conn_test",
      ...overrides,
    },
    providerSessionId: "conversation-a",
    clientTool: "test",
  });
  return executor.buildHeaders(credentials, true, "https://opencode.ai/zen/v1/chat/completions", model);
}

describe("OpenCode Zen free-tier routing and auth regression", () => {
  it("classifies suffix-based free models, Big Pickle, prefixes, and thinking overrides", () => {
    for (const model of [
      "mimo-v2.6-flash-free",
      "muse-spark-1.3-contributor-free",
      "deepseek-v4-flash-free",
      "jev-1.13-free",
      "big-pickle",
      "ocz/big-pickle(max)",
    ]) {
      expect(isOpencodeFreeTierModel(model)).toBe(true);
    }
    for (const model of ["muse-spark-1.3", "kimi-k3(max)", "gpt-5.5", "", null]) {
      expect(isOpencodeFreeTierModel(model)).toBe(false);
    }
  });

  it("recognizes namespaced Muse Spark models as Responses-only", () => {
    const formats = getModelSupportedFormats("ocz", "ocz/muse-spark-1.3-contributor-free");
    expect(formats).toContain("openai-responses");
  });

  it("routes free models to inference and preserves paid Zen endpoints", () => {
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

  it("uses v2 CLI fingerprint, public auth, and mirrored sessions for free-tier requests", () => {
    const headers = opencodeZenHeadersFor("mimo-v2.6-flash-free", {
      runtimeTransport: {
        headers: {
          "x-api-key": "legacy-api-key",
          "x-opencode-request": "msg_legacy_request_id",
        },
      },
    });
    const session = headers["x-opencode-session"];
    expect(headers.Authorization).toBe("Bearer public");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["x-opencode-request"]).toBeUndefined();
    expect(headers["User-Agent"]).toBe("opencode/latest/2.0.29/cli");
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-project"]).toBe("global");
    expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(session);
    expect(headers["x-session-affinity"]).toBe(session);
    expect(headers["x-session-id"]).toBe(session);
  });

  it("keeps the configured API key on paid models", () => {
    const headers = opencodeZenHeadersFor("kimi-k3", {
      runtimeTransport: { headers: { "x-api-key": "paid-custom-header" } },
    });
    expect(headers.Authorization).toBe("Bearer oc_sk_test_key");
    expect(headers["x-api-key"]).toBe("paid-custom-header");
  });

  it("sanitizes free-tier provider overrides after the base executor merges them", async () => {
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
    expect(options.headers.Authorization).toBe("Bearer public");
    for (const key of Object.keys(options.headers)) {
      expect(["authorization", "x-api-key", "x-opencode-request"]).not.toContain(key.toLowerCase());
    }
    expect(options.headers["X-Debug-Trace"]).toBe("preserve-me");
  });

  it("routes free Jev System One to inference with public auth", async () => {
    vi.stubGlobal("fetch", nativeFetchMock);
    await handleSystemoneCore({
      modelInfo: { provider: "opencode-zen", model: "jev-1.13-free" },
      body: { model: "jev-1.13-free", state: {}, questions: { q1: "answer this" } },
      credentials: { apiKey: "oc_sk_test_key", rawHeaders: {} },
    });

    expect(nativeFetchMock).toHaveBeenCalledOnce();
    const [url, options] = nativeFetchMock.mock.calls[0];
    expect(url).toBe("https://opencode.ai/inference/v1/systemone");
    expect(options.headers.Authorization).toBe("Bearer public");
    const session = options.headers["x-opencode-session"];
    expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(options.headers["x-opencode-session-id"]).toBe(session);
    expect(options.headers["x-session-affinity"]).toBe(session);
    expect(options.headers["x-session-id"]).toBe(session);
  });

  it("keeps paid Jev System One on Zen with the configured key", async () => {
    vi.stubGlobal("fetch", nativeFetchMock);
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
});
