import { afterEach, describe, it, expect, vi } from "vitest";

const envNames = [
  "HEADROOM_DEFAULT_ENABLED",
  "HEADROOM_DEFAULT_CODE_AWARE",
  "HEADROOM_DEFAULT_KOMPRESS",
  "HEADROOM_DEFAULT_COMPRESS_USER_MESSAGES",
];
const previous = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envNames) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  vi.resetModules();
});

describe("token saver defaults", () => {
  it("enables RTK, full Headroom, and full Ponytail for a new settings record", async () => {
    for (const key of envNames) delete process.env[key];
    vi.resetModules();
    const { mergeWithDefaults } = await import("../../src/lib/db/repos/settingsRepo.js");

    expect(mergeWithDefaults({})).toMatchObject({
      rtkEnabled: true,
      headroomEnabled: true,
      headroomTimeoutMs: 10000,
      headroomCodeAware: true,
      headroomKompress: true,
      headroomCompressUserMessages: true,
      ponytailEnabled: true,
      ponytailLevel: "full",
    });
  });

  it("allows an operator to disable automatic defaults via environment", async () => {
    process.env.HEADROOM_DEFAULT_ENABLED = "false";
    process.env.HEADROOM_DEFAULT_CODE_AWARE = "false";
    process.env.HEADROOM_DEFAULT_KOMPRESS = "false";
    process.env.HEADROOM_DEFAULT_COMPRESS_USER_MESSAGES = "false";
    vi.resetModules();
    const { mergeWithDefaults } = await import("../../src/lib/db/repos/settingsRepo.js");

    expect(mergeWithDefaults({})).toMatchObject({
      headroomEnabled: false,
      headroomCodeAware: false,
      headroomKompress: false,
      headroomCompressUserMessages: false,
    });
  });

  it("preserves an explicit setting already stored in the database", async () => {
    for (const key of envNames) delete process.env[key];
    vi.resetModules();
    const { mergeWithDefaults } = await import("../../src/lib/db/repos/settingsRepo.js");

    expect(mergeWithDefaults({
      headroomEnabled: false,
      headroomCodeAware: false,
      headroomKompress: false,
      headroomCompressUserMessages: false,
      ponytailEnabled: false,
    })).toMatchObject({
      rtkEnabled: true,
      headroomEnabled: false,
      headroomCodeAware: false,
      headroomKompress: false,
      headroomCompressUserMessages: false,
      ponytailEnabled: false,
    });
  });
});
