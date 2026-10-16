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

function hasRequiredExtras(status, requiredExtras) {
  return status?.installed === true
    && requiredExtras.every((extra) => status.extras?.[extra] === true);
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
  const requiredExtras = [];
  if (settings.headroomCodeAware === true) requiredExtras.push("code");
  if (settings.headroomKompress !== false) requiredExtras.push("ml");

  const python = findPython310();
  if (!python) {
    throw new Error("Python 3.10 or newer is required to install Headroom.");
  }

  let extras = getInstalledHeadroomExtras(python);
  if (!hasRequiredExtras(extras, requiredExtras)) {
    const summary = requiredExtras.length ? requiredExtras.join(" and ") : "proxy";
    console.info(
      `[Headroom] Installing proxy with requested compression features: ${summary}.`
      + (requiredExtras.includes("ml") ? " The ML extra can require a large download." : "")
    );
    const install = await installHeadroomExtras(requiredExtras);
    extras = {
      installed: install.installed,
      extras: install.extras,
      version: install.version,
    };
    if (!hasRequiredExtras(extras, requiredExtras)) {
      throw new Error(
        `Headroom installation completed without verifying requested extras: ${requiredExtras.join(", ") || "proxy"}.`
      );
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

export function bootstrapHeadroom({ force = false } = {}) {
  // A global promise prevents duplicate pip installs or competing proxy
  // launches when Next.js initializes more than one server module.
  const current = globalThis.__ninerouterHeadroomBootstrap;
  if (current && !force) return current;

  if (current && force) {
    // Settings may be changed while first-run package installation is still
    // in progress. Queue exactly one reconciliation using the latest settings
    // after the current run finishes instead of racing two pip installs.
    if (!globalThis.__ninerouterHeadroomBootstrapQueued) {
      const queued = current.then(() => {
        if (globalThis.__ninerouterHeadroomBootstrap === current) {
          globalThis.__ninerouterHeadroomBootstrap = null;
        }
        globalThis.__ninerouterHeadroomBootstrapQueued = null;
        return bootstrapHeadroom();
      });
      globalThis.__ninerouterHeadroomBootstrapQueued = queued;
    }
    return globalThis.__ninerouterHeadroomBootstrapQueued;
  }

  const pending = runBootstrap().catch((error) => {
    console.warn("[Headroom] Automatic setup failed; requests remain fail-open:", error?.message || String(error));
    return { started: false, error: error?.message || String(error) };
  });
  globalThis.__ninerouterHeadroomBootstrap = pending;

  // A skipped/failed run may be retried later, e.g. after a saved setting
  // enables Headroom or the operator fixes a missing system dependency.
  void pending.then((result) => {
    const canRetry = result?.error || result?.skipped;
    if (canRetry && globalThis.__ninerouterHeadroomBootstrap === pending) {
      globalThis.__ninerouterHeadroomBootstrap = null;
    }
  });
  return pending;
}
