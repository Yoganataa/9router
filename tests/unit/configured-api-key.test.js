import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalConfiguredKey = process.env.NINEROUTER_API_KEY;
const originalConfiguredName = process.env.NINEROUTER_API_KEY_NAME;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-configured-key-"));
  process.env.DATA_DIR = tempDir;
  process.env.NINEROUTER_API_KEY = "sk-configured-secret-for-testing-123456789";
  process.env.NINEROUTER_API_KEY_NAME = "Test Environment Key";
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalConfiguredKey === undefined) delete process.env.NINEROUTER_API_KEY;
  else process.env.NINEROUTER_API_KEY = originalConfiguredKey;
  if (originalConfiguredName === undefined) delete process.env.NINEROUTER_API_KEY_NAME;
  else process.env.NINEROUTER_API_KEY_NAME = originalConfiguredName;
});

describe("configured API key", () => {
  it("creates and activates a configured key in a fresh database", async () => {
    const { getApiKeys, getApiKeyByKey, validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = process.env.NINEROUTER_API_KEY;

    expect(await validateApiKey(key)).toBe(true);
    expect(await getApiKeyByKey(key)).toMatchObject({
      key,
      name: "Test Environment Key",
      isActive: true,
    });

    const keys = await getApiKeys();
    expect(keys.filter((entry) => entry.key === key)).toHaveLength(1);
  });

  it("reconciles a changed configured key without leaving the previous managed key active", async () => {
    const { getApiKeys, validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const previousKey = process.env.NINEROUTER_API_KEY;
    expect(await validateApiKey(previousKey)).toBe(true);

    const nextKey = "sk-next-configured-secret-for-testing-987654321";
    process.env.NINEROUTER_API_KEY = nextKey;

    expect(await validateApiKey(nextKey)).toBe(true);
    expect(await validateApiKey(previousKey)).toBe(false);

    const keys = await getApiKeys();
    expect(keys.filter((entry) => entry.key === nextKey)).toHaveLength(1);
    expect(keys.some((entry) => entry.key === previousKey && entry.isActive)).toBe(false);
  });

  it("does nothing when no configured key is provided", async () => {
    delete process.env.NINEROUTER_API_KEY;
    const { getApiKeys } = await import("@/lib/db/repos/apiKeysRepo.js");

    expect(await getApiKeys()).toHaveLength(0);
  });
});
