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
  let installError = null;
  if (!hasRequiredExtras(extras, requiredExtras)) {
    const summary = requiredExtras.length ? requiredExtras.join(" and ") : "proxy";
    console.info(
      `[Headroom] Installing proxy with requested compression features: ${summary}.`
      + (requiredExtras.includes("ml") ? " The ML extra can require a large download." : "")
    );
    try {
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
    } catch (error) {
      // An optional heavy extra (especially ML/PyTorch) must not keep the
      // base proxy permanently stopped when headroom-ai or another requested
      // extra is already available. Re-detect installed packages and run in a
      // truthful degraded mode while exposing the installation error in logs.
      installError = error?.message || String(error);
      extras = getInstalledHeadroomExtras(python);
      if (!extras.installed) throw error;
      const missing = requiredExtras.filter((extra) => extras.extras?.[extra] !== true);
      console.warn(
        `[Headroom] Requested extras could not all be installed (${missing.join(", ") || "unknown"}); starting the available proxy features. ${installError}`
      );
    }
  }

  const missingExtras = requiredExtras.filter((extra) => extras.extras?.[extra] !== true);
  const activeCodeAware = settings.headroomCodeAware === true && extras.extras?.code === true;
  const activeKompress = settings.headroomKompress !== false && extras.extras?.ml === true;
  const running = await probeProxyRunning(url);
  const managedPid = getManagedPid();
  const options = {
    port,
    codeAware: activeCodeAware,
    // If [ml] is missing, explicitly disable Kompress so Headroom does not
    // exit during startup trying to load an unavailable ML dependency.
    kompress: activeKompress,
  };

  if (running && managedPid) {
    // Reapply the default flags after package upgrades or a server restart.
    await restartHeadroomProxy(options);
    console.info(
      missingExtras.length
        ? `[Headroom] Proxy is healthy in partial mode; missing extras: ${missingExtras.join(", ")}.`
        : "[Headroom] Full proxy is healthy and running with configured compression flags."
    );
    return {
      started: true,
      restarted: true,
      version: extras.version,
      extras: extras.extras,
      missingExtras,
      warning: installError || (missingExtras.length ? `Missing extras: ${missingExtras.join(", ")}` : null),
    };
  }

  if (running) {
    // Never terminate an externally managed proxy just to enforce our flags.
    console.warn("[Headroom] A proxy is already healthy but is not managed by this instance. It was left untouched; its launch flags cannot be verified.");
    return {
      started: false,
      alreadyRunning: true,
      managed: false,
      version: extras.version,
      extras: extras.extras,
      missingExtras,
      warning: installError || (missingExtras.length ? `Missing extras: ${missingExtras.join(", ")}` : "Externally managed proxy; launch flags were not verified"),
    };
  }

  const result = await startHeadroomProxy(options);
  console.info(
    missingExtras.length
      ? `[Headroom] Proxy is healthy in partial mode; missing extras: ${missingExtras.join(", ")}.`
      : "[Headroom] Full proxy is healthy and running with configured compression flags."
  );
  return {
    started: true,
    ...result,
    version: extras.version,
    extras: extras.extras,
    missingExtras,
    warning: installError || (missingExtras.length ? `Missing extras: ${missingExtras.join(", ")}` : null),
  };
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

  globalThis.__ninerouterHeadroomBootstrapState = {
    status: "starting",
    startedAt: Date.now(),
    missingExtras: [],
    warning: null,
  };
  const pending = runBootstrap().catch((error) => {
    const message = error?.message || String(error);
    console.warn("[Headroom] Automatic setup failed; requests remain fail-open:", message);
    return { started: false, error: message };
  }).then((result) => {
    const missingExtras = Array.isArray(result?.missingExtras) ? result.missingExtras : [];
    const status = result?.error
      ? "error"
      : result?.skipped
        ? "skipped"
        : missingExtras.length || result?.warning
          ? "degraded"
          : result?.started
            ? "ready"
            : "stopped";
    globalThis.__ninerouterHeadroomBootstrapState = {
      status,
      updatedAt: Date.now(),
      missingExtras,
      warning: result?.warning || result?.error || null,
      version: result?.version || null,
      extras: result?.extras || null,
    };
    return result;
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
