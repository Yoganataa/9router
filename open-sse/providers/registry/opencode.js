export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    forceStream: true,
    noAuth: true,
    // Recover from transient OpenCode gateway 429s internally; OpenCodeExecutor
    // vetoes retries unless the response says "Endpoint is unavailable".
    retry: {
      429: { attempts: 5, delayMs: 2000 },
    },
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
    },
  },
  models: [
    // Endpoint formats differ per model, so declare non-chat models explicitly.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "union-alpha", name: "Union Alpha Free", targetFormat: "claude" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free", kind: "systemone" },
  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/inference/v1/systemone",
    headers: {
      "x-opencode-client": "desktop",
      "User-Agent": "opencode/latest/2.0.29/cli",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
