import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  findPython310: vi.fn(() => "python3"),
  getInstalledHeadroomExtras: vi.fn(),
  isLoopbackHeadroomUrl: vi.fn(() => true),
  probeProxyRunning: vi.fn(),
  getManagedPid: vi.fn(),
  installHeadroomExtras: vi.fn(),
  restartHeadroomProxy: vi.fn(),
  startHeadroomProxy: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("../../src/lib/headroom/detect.js", () => ({
  DEFAULT_HEADROOM_URL: "http://localhost:8787",
  findPython310: mocks.findPython310,
  getInstalledHeadroomExtras: mocks.getInstalledHeadroomExtras,
  isLoopbackHeadroomUrl: mocks.isLoopbackHeadroomUrl,
  probeProxyRunning: mocks.probeProxyRunning,
}));

vi.mock("../../src/lib/headroom/process.js", () => ({
  getManagedPid: mocks.getManagedPid,
  installHeadroomExtras: mocks.installHeadroomExtras,
  restartHeadroomProxy: mocks.restartHeadroomProxy,
  startHeadroomProxy: mocks.startHeadroomProxy,
}));

import { bootstrapHeadroom } from "../../src/lib/headroom/bootstrap.js";

const fullExtras = {
  installed: true,
  version: "0.41.0",
  extras: { code: true, ml: true },
};

beforeEach(() => {
  delete globalThis.__ninerouterHeadroomBootstrap;
  vi.clearAllMocks();
  delete process.env.HEADROOM_AUTO_SETUP;
  mocks.getSettings.mockResolvedValue({
    headroomEnabled: true,
    headroomUrl: "http://localhost:8787",
    headroomCodeAware: true,
    headroomKompress: true,
  });
  mocks.findPython310.mockReturnValue("python3");
  mocks.getInstalledHeadroomExtras.mockReturnValue(fullExtras);
  mocks.isLoopbackHeadroomUrl.mockReturnValue(true);
  mocks.probeProxyRunning.mockResolvedValue(false);
  mocks.getManagedPid.mockReturnValue(null);
  mocks.installHeadroomExtras.mockResolvedValue({ success: true, ...fullExtras });
  mocks.startHeadroomProxy.mockResolvedValue({ healthy: true, pid: 1234 });
  mocks.restartHeadroomProxy.mockResolvedValue({ healthy: true, pid: 1234 });
});

describe("Headroom first-run bootstrap", () => {
  it("installs proxy, code, and ml extras and starts full mode by default", async () => {
    mocks.getInstalledHeadroomExtras.mockReturnValue({
      installed: false,
      version: null,
      extras: { code: false, ml: false },
    });

    const result = await bootstrapHeadroom();

    expect(mocks.installHeadroomExtras).toHaveBeenCalledWith(["code", "ml"]);
    expect(mocks.startHeadroomProxy).toHaveBeenCalledWith({
      port: 8787,
      codeAware: true,
      kompress: true,
    });
    expect(result).toMatchObject({ started: true, healthy: true, extras: { code: true, ml: true } });
  });

  it("restarts a managed running proxy to apply the full-mode flags", async () => {
    mocks.probeProxyRunning.mockResolvedValue(true);
    mocks.getManagedPid.mockReturnValue(2468);

    const result = await bootstrapHeadroom();

    expect(mocks.installHeadroomExtras).not.toHaveBeenCalled();
    expect(mocks.restartHeadroomProxy).toHaveBeenCalledWith({
      port: 8787,
      codeAware: true,
      kompress: true,
    });
    expect(mocks.startHeadroomProxy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ started: true, restarted: true });
  });

  it("does not stop or restart a healthy externally managed proxy", async () => {
    mocks.probeProxyRunning.mockResolvedValue(true);

    const result = await bootstrapHeadroom();

    expect(mocks.restartHeadroomProxy).not.toHaveBeenCalled();
    expect(mocks.startHeadroomProxy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ started: false, alreadyRunning: true, managed: false });
  });

  it("leaves external proxy URLs to their owner", async () => {
    mocks.getSettings.mockResolvedValue({
      headroomEnabled: true,
      headroomUrl: "https://headroom.example.com",
      headroomCodeAware: true,
      headroomKompress: true,
    });
    mocks.isLoopbackHeadroomUrl.mockReturnValue(false);

    const result = await bootstrapHeadroom();

    expect(mocks.findPython310).not.toHaveBeenCalled();
    expect(mocks.installHeadroomExtras).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, reason: "external proxy" });
  });

  it("can be disabled explicitly for environments that manage Headroom separately", async () => {
    process.env.HEADROOM_AUTO_SETUP = "false";

    const result = await bootstrapHeadroom();

    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(mocks.installHeadroomExtras).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  it("does nothing when Headroom was explicitly disabled in settings", async () => {
    mocks.getSettings.mockResolvedValue({ headroomEnabled: false });

    const result = await bootstrapHeadroom();

    expect(mocks.installHeadroomExtras).not.toHaveBeenCalled();
    expect(mocks.startHeadroomProxy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  it("retries after Headroom was disabled at boot and later enabled in settings", async () => {
    mocks.getSettings
      .mockResolvedValueOnce({ headroomEnabled: false })
      .mockResolvedValue({
        headroomEnabled: true,
        headroomUrl: "http://localhost:8787",
        headroomCodeAware: true,
        headroomKompress: true,
      });

    const first = await bootstrapHeadroom();
    expect(first).toMatchObject({ skipped: true, reason: "Headroom is disabled in settings" });
    await Promise.resolve();

    const second = await bootstrapHeadroom();

    expect(mocks.startHeadroomProxy).toHaveBeenCalledWith({
      port: 8787,
      codeAware: true,
      kompress: true,
    });
    expect(second).toMatchObject({ started: true, healthy: true });
  });
});
