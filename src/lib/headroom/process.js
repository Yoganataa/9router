import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { DATA_DIR } from "@/lib/dataDir.js";
import { findHeadroomBinary, findPython310, HEADROOM_COMPRESSION_EXTRAS, EXTRA_MARKERS, getInstalledHeadroomExtras, probeProxyRunning } from "./detect.js";

const HEADROOM_DIR = path.join(DATA_DIR, "headroom");
const PID_FILE = path.join(HEADROOM_DIR, "proxy.pid");
const LOG_FILE = path.join(HEADROOM_DIR, "proxy.log");
const INSTALL_LOG_FILE = path.join(HEADROOM_DIR, "install.log");
const DEFAULT_PORT = 8787;
const STARTUP_TIMEOUT_MS = 30000;
const STARTUP_EXIT_GRACE_MS = 2500;
const HEALTH_POLL_INTERVAL_MS = 350;

function ensureDir() {
  if (!fs.existsSync(HEADROOM_DIR)) fs.mkdirSync(HEADROOM_DIR, { recursive: true });
}

function readPid() {
  try {
    if (fs.existsSync(PID_FILE)) return parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
  } catch { /* ignore */ }
  return null;
}

function writePid(pid) {
  ensureDir();
  fs.writeFileSync(PID_FILE, String(pid));
}

function clearPid(expectedPid = null) {
  try {
    if (!fs.existsSync(PID_FILE)) return;
    if (expectedPid !== null && readPid() !== Number(expectedPid)) return;
    fs.unlinkSync(PID_FILE);
  } catch { /* ignore */ }
}

// process.kill throws if pid is dead — use this to probe.
export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function getManagedPid() {
  const pid = readPid();
  return pid && isPidAlive(pid) ? pid : null;
}

// Build proxy CLI flags for the active compression extras. `[code]` (AST
// compression) is off by default in headroom → pass --code-aware to turn it on;
// `[ml]` (Kompress) is on by default → pass --disable-kompress to turn it off.
function extrasProxyArgs({ codeAware, kompress } = {}) {
  const args = [];
  if (codeAware) args.push("--code-aware");
  if (kompress === false) args.push("--disable-kompress");
  return args;
}

export async function startHeadroomProxy({ port = DEFAULT_PORT, codeAware = false, kompress = true } = {}) {
  const safePort = Number(port) > 0 && Number(port) < 65536 ? Number(port) : DEFAULT_PORT;
  const url = `http://127.0.0.1:${safePort}`;
  const recordedPid = readPid();
  const existing = getManagedPid();

  // Health is authoritative: a previous proxy may already be serving even if
  // its launcher PID was not retained by the current 9Router process.
  if (await probeProxyRunning(url)) {
    if (recordedPid && !existing) clearPid(recordedPid);
    return { pid: existing || null, alreadyRunning: true, managed: Boolean(existing), healthy: true };
  }

  if (recordedPid && !existing) clearPid(recordedPid);
  if (existing) {
    const err = new Error(
      `Headroom process ${existing} is alive but ${url}/health is not responding. Stop or restart that process before starting another instance.`
    );
    err.code = "HEADROOM_UNHEALTHY";
    throw err;
  }

  const binary = findHeadroomBinary();
  if (!binary) {
    const err = new Error("Headroom CLI not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }

  ensureDir();
  const outFd = fs.openSync(LOG_FILE, "a");
  let child = null;
  let fdOpen = true;
  let exitInfo = null;

  const closeLogFd = () => {
    if (!fdOpen) return;
    fdOpen = false;
    try { fs.closeSync(outFd); } catch { /* already closed */ }
  };

  try {
    const args = ["proxy", "--port", String(safePort), ...extrasProxyArgs({ codeAware, kompress })];
    child = spawn(binary, args, {
      stdio: ["ignore", outFd, outFd],
      detached: true,
      windowsHide: true,
      env: { ...process.env },
    });

    child.once("exit", (code, signal) => {
      exitInfo = { code, signal, at: Date.now() };
      if (child?.pid) clearPid(child.pid);
    });

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    if (!child.pid) {
      const err = new Error("Failed to spawn Headroom proxy");
      err.code = "SPAWN_FAILED";
      throw err;
    }

    child.unref();
    writePid(child.pid);

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Do not treat the launcher process exit as a failure if the service is
      // already healthy. The proxy may be managed by another process.
      if (await probeProxyRunning(url)) {
        const managed = isPidAlive(child.pid);
        if (!managed) clearPid(child.pid);
        closeLogFd();
        return {
          pid: managed ? child.pid : null,
          alreadyRunning: !managed,
          managed,
          healthy: true,
        };
      }

      if (exitInfo && Date.now() - exitInfo.at >= STARTUP_EXIT_GRACE_MS) {
        const detail = exitInfo.signal
          ? `signal ${exitInfo.signal}`
          : `code=${exitInfo.code}`;
        const err = new Error(`Headroom proxy ${detail} before ${url}/health became ready — see proxy.log`);
        err.code = "EARLY_EXIT";
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }

    const err = new Error(`Headroom proxy did not become healthy at ${url}/health within ${STARTUP_TIMEOUT_MS / 1000}s — see proxy.log`);
    err.code = "STARTUP_TIMEOUT";
    throw err;
  } catch (error) {
    if (child?.pid && isPidAlive(child.pid)) {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    if (child?.pid) clearPid(child.pid);
    throw error;
  } finally {
    closeLogFd();
  }
}

export function stopHeadroomProxy() {
  const pid = getManagedPid();
  if (!pid) return { stopped: false, reason: "not_running" };
  try {
    process.kill(pid, "SIGTERM");
    // Give it a moment, then force if still alive.
    setTimeout(() => {
      if (isPidAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }, 2000);
    clearPid();
    return { stopped: true, pid };
  } catch (e) {
    clearPid();
    const err = new Error(`Failed to stop headroom proxy: ${e.message}`);
    err.code = "STOP_FAILED";
    throw err;
  }
}

// Stop the managed proxy (if any), wait for the pid to die, then start again
// with the given flags. Used when toggling active extras that require a restart.
export async function restartHeadroomProxy(opts = {}) {
  const pid = getManagedPid();
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    // Wait up to ~3s for graceful exit, force-kill if still alive.
    for (let i = 0; i < 30 && isPidAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isPidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    clearPid();
  }
  return startHeadroomProxy(opts);
}

export function getHeadroomLogTail(maxLines = 200) {
  try {
    if (!fs.existsSync(LOG_FILE)) return "";
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch { return ""; }
}

// Install (or upgrade) headroom-ai with the requested compression extras.
// `extras` is a whitelist from HEADROOM_COMPRESSION_EXTRAS — anything else
// is rejected to keep the install surface predictable. Always installs the
// `proxy` base + whatever extras the user picked, regardless of what is
// already present.
export async function installHeadroomExtras(extras = []) {
  const requested = Array.isArray(extras) ? extras.filter((e) => HEADROOM_COMPRESSION_EXTRAS.includes(e)) : [];
  const py = findPython310();
  if (!py) {
    const err = new Error("Python >= 3.10 not found");
    err.code = "NO_PYTHON";
    throw err;
  }
  if (!findHeadroomBinary()) {
    const err = new Error("headroom-ai not installed (run `pip install headroom-ai[proxy]` first)");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  // pip install string is built from a closed set (HEADROOM_COMPRESSION_EXTRAS),
  // so it cannot be poisoned by caller input — the comma-list is a fixed
  // ['proxy', ...requested]. No shell interpolation.
  const extrasList = ["proxy", ...requested].join(",");
  const spec = `headroom-ai[${extrasList}]`;
  const args = ["-m", "pip", "install", "--upgrade", spec];

  ensureDir();
  // Truncate ("w") so the log reflects only the current install for live progress.
  const outFd = fs.openSync(INSTALL_LOG_FILE, "w");
  const child = spawn(py, args, {
    stdio: ["ignore", outFd, outFd],
    windowsHide: true,
    env: { ...process.env },
  });

  return new Promise((resolve, reject) => {
    child.once("error", (e) => { fs.closeSync(outFd); reject(e); });
    child.once("exit", (code) => {
      fs.closeSync(outFd);
      const status = getInstalledHeadroomExtras(py);
      const missing = requested.filter((extra) => status.extras?.[extra] !== true);
      if (status.installed && missing.length === 0) {
        resolve({
          success: true,
          code,
          spec,
          extras: requested,
          ...status,
          ...(code === 0 ? {} : {
            warning: `pip exited with code=${code}, but all requested extras were verified as installed.`,
          }),
        });
      } else {
        const detail = missing.length
          ? ` Requested extras not verified: ${missing.join(", ")}.`
          : " The headroom-ai installation could not be verified.";
        const err = new Error(
          `pip install exited with code=${code} — see headroom/install.log.${detail}`
        );
        err.code = code === 0 ? "EXTRA_VERIFY_FAILED" : "INSTALL_FAILED";
        reject(err);
      }
    });
  });
}

// Uninstall the marker packages that back a single extra (e.g. `ml` → torch,
// huggingface-hub). `headroom-ai` base and the `proxy` extra are never removed.
export async function uninstallHeadroomExtras(extras = []) {
  const requested = Array.isArray(extras) ? extras.filter((e) => HEADROOM_COMPRESSION_EXTRAS.includes(e)) : [];
  const py = findPython310();
  if (!py) {
    const err = new Error("Python >= 3.10 not found");
    err.code = "NO_PYTHON";
    throw err;
  }
  const pkgs = [...new Set(requested.flatMap((e) => EXTRA_MARKERS[e] || []))];
  if (pkgs.length === 0) {
    const err = new Error("No valid extras to remove");
    err.code = "INVALID_EXTRAS";
    throw err;
  }
  const args = ["-m", "pip", "uninstall", "-y", ...pkgs];

  ensureDir();
  const outFd = fs.openSync(INSTALL_LOG_FILE, "w");
  const child = spawn(py, args, {
    stdio: ["ignore", outFd, outFd],
    windowsHide: true,
    env: { ...process.env },
  });

  return new Promise((resolve, reject) => {
    child.once("error", (e) => { fs.closeSync(outFd); reject(e); });
    child.once("exit", (code) => {
      fs.closeSync(outFd);
      if (code === 0) {
        const status = getInstalledHeadroomExtras(py);
        resolve({ success: true, code, removed: pkgs, extras: requested, ...status });
      } else {
        const err = new Error(`pip uninstall exited with code=${code} — see headroom/install.log`);
        err.code = "UNINSTALL_FAILED";
        reject(err);
      }
    });
  });
}

// Read the tail of the install/uninstall log for live progress in the UI.
export function getInstallLogTail(maxLines = 15) {
  try {
    if (!fs.existsSync(INSTALL_LOG_FILE)) return "";
    const lines = fs.readFileSync(INSTALL_LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch { return ""; }
}
