import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  findHeadroomBinary: vi.fn(() => "/usr/local/bin/headroom"),
  probeProxyRunning: vi.fn(),
  findPython310: vi.fn(),
  getInstalledHeadroomExtras: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("../../src/lib/headroom/detect.js", () => ({
  findHeadroomBinary: mocks.findHeadroomBinary,
  findPython310: mocks.findPython310,
  HEADROOM_COMPRESSION_EXTRAS: ["code", "ml"],
  EXTRA_MARKERS: { code: ["tree-sitter", "tree-sitter-language-pack"], ml: ["torch", "huggingface-hub"] },
  getInstalledHeadroomExtras: mocks.getInstalledHeadroomExtras,
  probeProxyRunning: mocks.probeProxyRunning,
}));

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-headroom-process-"));
  process.env.DATA_DIR = tempDir;
  mocks.spawn.mockReset();
  mocks.findHeadroomBinary.mockReset().mockReturnValue("/usr/local/bin/headroom");
  mocks.probeProxyRunning.mockReset();
  mocks.findPython310.mockReset();
  mocks.getInstalledHeadroomExtras.mockReset();
  vi.resetModules();
});

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function fakeChild(pid = process.pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = vi.fn();
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  return child;
}

describe("Headroom proxy process management", () => {
  it("accepts a healthy existing proxy instead of spawning a conflicting second process", async () => {
    mocks.probeProxyRunning.mockResolvedValue(true);
    const { startHeadroomProxy } = await import("../../src/lib/headroom/process.js");

    const result = await startHeadroomProxy({ port: 8787, codeAware: true, kompress: true });

    expect(result).toMatchObject({ pid: null, alreadyRunning: true, managed: false, healthy: true });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("reports success when the service is healthy even if its launcher exits", async () => {
    const child = fakeChild(2147483647);
    mocks.probeProxyRunning
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    setTimeout(() => child.emit("exit", 1, null), 0);

    const { startHeadroomProxy } = await import("../../src/lib/headroom/process.js");
    const result = await startHeadroomProxy({ port: 8787, codeAware: true, kompress: true });

    expect(result).toMatchObject({ pid: null, alreadyRunning: true, managed: false, healthy: true });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/usr/local/bin/headroom",
      ["proxy", "--port", "8787", "--code-aware"],
      expect.objectContaining({ detached: true, windowsHide: true })
    );
  });

  it("passes the configured compression flags to the proxy process", async () => {
    fakeChild(process.pid);
    mocks.probeProxyRunning.mockResolvedValueOnce(false).mockResolvedValue(true);

    const { startHeadroomProxy } = await import("../../src/lib/headroom/process.js");
    const result = await startHeadroomProxy({ port: 8787, codeAware: true, kompress: false });

    expect(result.healthy).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/usr/local/bin/headroom",
      ["proxy", "--port", "8787", "--code-aware", "--disable-kompress"],
      expect.any(Object)
    );
  });
});
