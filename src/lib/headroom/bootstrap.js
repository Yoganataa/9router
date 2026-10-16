import { getSettings } from "@/lib/localDb";
import {
  DEFAULT_HEADROOM_URL,
  findPython310,
  getInstalledHeadroomExtras,
  isLoopbackHeadroomUrl,
  probeProxyRunning,
} from "./detect.js";
import {
  getManagedPid,
  installHeadroomExtras,
  restartHeadroomProxy,
  startHeadroomProxy,
} from "./process.js";

const REQUIRED_EXTRAS = ["code", "ml"];
const DEFAULT_PORT = 8787;

function parsePort(url) {
  try {
    const port = Number.parseInt(new URL(url).port, 10);
    return port > 0 && port < 65536 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function envDisabled(name) {
  return /^(0|false|no|off)$/i.test(String(process.env[name] || "").trim());
}

function hasFullExtras(status) {
  return status?.installed === true
    && REQUIRED_EXTRAS.every((extra) => status.extras?.[extra] === true);
}

async function runBootstrap() {
  if (envDisabled("HEADROOM_AUTO_SETUP")) {
    return { skipped: true, reason: "disabled by HEADROOM_AUTO_SETUP" };
  }

  const settings = await getSettings();
  if (settings.headroomEnabled !== true) {
    return { skipped: true, reason: "Headroom is disabled in settings" };
  }

  const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
  if (!isLoopbackHeadroomUrl(url)) {
    console.info("[Headroom] External proxy configured; leaving installation and process management to the external service.");
    return { skipped: true, reason: "external proxy" };
  }

  const port = parsePort(url);
  const python = findPython310();
  if (!python) {
    throw new Error("Python 3.10 or newer is required to install Headroom.");
  }

  let extras = getInstalledHeadroomExtras(python);
  if (!hasFullExtras(extras)) {
    console.info("[Headroom] Installing proxy with Code-Aware and ML compression extras. The ML extra can require a large download.");
    const install = await installHeadroomExtras(REQUIRED_EXTRAS);
    extras = {
      installed: install.installed,
      extras: install.extras,
      version: install.version,
    };
    if (!hasFullExtras(extras)) {
      throw new Error("Headroom installation completed without verifying both Code-Aware and ML extras.");
    }
  }

  const running = await probeProxyRunning(url);
  const managedPid = getManagedPid();
  const options = {
    port,
    codeAware: settings.headroomCodeAware === true,
    kompress: settings.headroomKompress !== false,
  };

  if (running && managedPid) {
    // Reapply the default flags after package upgrades or a server restart.
    await restartHeadroomProxy(options);
    console.info("[Headroom] Full proxy is healthy and running with configured compression flags.");
    return { started: true, restarted: true, version: extras.version, extras: extras.extras };
  }

  if (running) {
    // Never terminate an externally managed proxy just to enforce our flags.
    console.warn("[Headroom] A proxy is already healthy but is not managed by this instance. It was left untouched; restart it with the configured flags to guarantee full mode.");
    return { started: false, alreadyRunning: true, managed: false, version: extras.version, extras: extras.extras };
  }

  const result = await startHeadroomProxy(options);
  console.info("[Headroom] Full proxy is healthy and running with configured compression flags.");
  return { started: true, ...result, version: extras.version, extras: extras.extras };
}

export function bootstrapHeadroom() {
  // A global promise prevents duplicate pip installs or competing proxy
  // launches when Next.js initializes more than one server module.
  if (!globalThis.__ninerouterHeadroomBootstrap) {
    globalThis.__ninerouterHeadroomBootstrap = runBootstrap().catch((error) => {
      console.warn("[Headroom] Automatic setup failed; requests remain fail-open:", error?.message || String(error));
      return { started: false, error: error?.message || String(error) };
    });
  }
  return globalThis.__ninerouterHeadroomBootstrap;
}
