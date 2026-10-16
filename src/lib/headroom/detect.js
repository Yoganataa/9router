import fs from "fs";
import { execFileSync, execSync } from "child_process";
import path from "path";

// Extras that improve headroom compression quality. `proxy` is the base;
// `code` adds tree-sitter AST compression; `ml` adds Kompress-v2 HF model.
// Other `[all]` extras (image, voice, otel, reports, evals, ...) are not
// useful for the 9router proxy use case, so we don't track them here.
export const HEADROOM_COMPRESSION_EXTRAS = ["code", "ml"];

// Marker packages that each extra pulls in. Detected from `pip list --format=json`
// so one call can answer both the installed version and active extras.
export const EXTRA_MARKERS = {
  code: ["tree-sitter", "tree-sitter-language-pack"],
  ml: ["torch", "huggingface-hub"],
};

const HEADROOM_PIP_TIMEOUT_MS = 8000;

const IS_WIN = process.platform === "win32";
const WHICH_CMD = IS_WIN ? "where" : "which";

// Extra bin dirs often missing from a packaged/launchd PATH (Python installs headroom here).
const EXTRA_BINS = IS_WIN
  ? [
      `${process.env.LOCALAPPDATA || ""}\\Programs\\Python\\Python313\\Scripts`,
      `${process.env.LOCALAPPDATA || ""}\\Programs\\Python\\Python312\\Scripts`,
      `${process.env.LOCALAPPDATA || ""}\\Programs\\Python\\Python311\\Scripts`,
      `${process.env.LOCALAPPDATA || ""}\\Programs\\Python\\Python310\\Scripts`,
      `${process.env.APPDATA || ""}\\Python\\Python313\\Scripts`,
    ]
  : [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/Library/Frameworks/Python.framework/Versions/3.13/bin",
      "/Library/Frameworks/Python.framework/Versions/3.12/bin",
      "/Library/Frameworks/Python.framework/Versions/3.11/bin",
      "/Library/Frameworks/Python.framework/Versions/3.10/bin",
      `${process.env.HOME || ""}/.local/bin`,
      "/usr/bin",
      "/bin",
    ];

function bundledHeadroomCandidates() {
  const executable = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : "";
  return [
    process.env.NINEROUTER_HEADROOM_BUNDLE_DIR,
    process.env.HEADROOM_BUNDLE_DIR,
    executable && path.join(executable, "headroom-runtime"),
    process.cwd() && path.join(process.cwd(), "headroom-runtime"),
    process.cwd() && path.join(process.cwd(), "app", "headroom-runtime"),
    process.cwd() && path.join(process.cwd(), "package", "app", "headroom-runtime"),
  ].filter(Boolean);
}

export function findBundledHeadroomDir() {
  return bundledHeadroomCandidates().find((dir) =>
    fs.existsSync(path.join(dir, "bin", "headroom"))
    && fs.existsSync(path.join(dir, "site-packages"))
  ) || null;
}

function headroomRuntimeEnv() {
  const bundleDir = findBundledHeadroomDir();
  const bundleBins = bundleDir ? [path.join(bundleDir, "bin")] : [];
  const bundlePackages = bundleDir ? path.join(bundleDir, "site-packages") : "";
  const pythonPath = [bundlePackages, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter);
  return {
    ...process.env,
    PATH: [...bundleBins, ...EXTRA_BINS, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
    ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
  };
}

const EXTENDED_PATH = [...EXTRA_BINS, process.env.PATH || ""].filter(Boolean).join(path.delimiter);
const PYTHON_CANDIDATES = ["python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"];
const MIN_VERSION = [3, 10];
const HEADROOM_HEALTH_TIMEOUT_MS = 1500;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

// Detect whether the headroom CLI is installed and where its binary lives.
export function findHeadroomBinary() {
  const bundled = findBundledHeadroomDir();
  if (bundled) return path.join(bundled, "bin", "headroom");
  try {
    const out = execSync(`${WHICH_CMD} headroom`, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: { ...headroomRuntimeEnv(), PATH: headroomRuntimeEnv().PATH },
    }).toString().trim();
    // Windows `where` may return multiple lines — take the first.
    return out ? out.split(/\r?\n/)[0].trim() : null;
  } catch {
    return null;
  }
}

// Find a Python interpreter >= 3.10 (headroom-ai requires it). Returns null if none.
// `python3`, `python3.13`, `python` can point at different envs on any OS. Prefer
// the interpreter that can also see the installed `headroom-ai` package so the
// dashboard probes and install action operate on the same interpreter as the CLI.
// Falls back to the first version-eligible candidate when headroom-ai is not yet
// installed anywhere (needed for the initial install).
// Interpreters to probe, most specific first: the python next to the headroom
// binary (guaranteed to have headroom-ai), then full paths from EXTRA_BINS, then
// bare names resolved via PATH.
function pythonCandidates() {
  // A release bundle has a known ABI target; avoid probing every system path at startup.
  if (findBundledHeadroomDir()) return ["python3.12", "python3", "python"];

  const list = [];
  const bin = findHeadroomBinary();
  if (bin) {
    const dir = path.dirname(bin);
    const names = IS_WIN ? ["python.exe", "python3.exe"] : ["python3", "python3.13", "python"];
    for (const n of names) list.push(path.join(dir, n));
  }
  for (const dir of EXTRA_BINS) {
    if (!dir) continue;
    for (const n of PYTHON_CANDIDATES) list.push(path.join(dir, IS_WIN ? `${n}.exe` : n));
  }
  list.push(...PYTHON_CANDIDATES);
  return list;
}

export function findPython310() {
  let fallback = null;
  // The release bundle is built against CPython 3.12 on Linux x86_64.
  // Do not select another interpreter merely because PYTHONPATH exposes its metadata.
  const hasBundledRuntime = Boolean(findBundledHeadroomDir());
  for (const candidate of pythonCandidates()) {
    try {
      const ver = execSync(`${candidate} --version`, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: headroomRuntimeEnv(),
      }).toString().trim();
      const match = ver.match(/(\d+)\.(\d+)/);
      if (!match) continue;
      const [major, minor] = [parseInt(match[1], 10), parseInt(match[2], 10)];
      if (!(major > MIN_VERSION[0] || (major === MIN_VERSION[0] && minor >= MIN_VERSION[1]))) continue;
      if (hasBundledRuntime && (major !== 3 || minor !== 12)) continue;
      if (!fallback) fallback = candidate;
      try {
        execFileSync(candidate, ["-m", "pip", "show", "headroom-ai"], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
          timeout: HEADROOM_PIP_TIMEOUT_MS,
          env: headroomRuntimeEnv(),
        });
        return candidate;
      } catch {
        // Keep scanning until an interpreter that sees headroom-ai is found.
      }
    } catch {
      // candidate not present, try next
    }
  }
  return fallback;
}

// Probe whether a Headroom proxy is reachable at the given URL by hitting /health.
export async function probeProxyRunning(url) {
  if (!url) return false;
  const base = String(url).replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(HEADROOM_HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

export function isLoopbackHeadroomUrl(url) {
  try {
    const parsed = new URL(url);
    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// Aggregate status for the dashboard: installed, running, python interpreter.
export async function getHeadroomStatus(url) {
  const path = findHeadroomBinary();
  const python = findPython310();
  const installed = Boolean(path);
  const running = await probeProxyRunning(url);
  const localUrl = isLoopbackHeadroomUrl(url);
  const extrasStatus = installed ? getInstalledHeadroomExtras(python) : { installed: false, version: null, extras: { code: false, ml: false } };
  return {
    installed,
    path,
    running,
    python,
    localUrl,
    canStart: installed && localUrl,
    version: extrasStatus.version,
    extras: extrasStatus.extras,
  };
}

// Parse installed headroom-ai version + which compression extras are
// actually installed (detected via marker package presence). One `pip list`
// call is enough to answer both questions.
//
// Returns: { installed: bool, version: string|null, extras: { code, ml } }
export function getInstalledHeadroomExtras(python) {
  const py = python || findPython310();
  if (!py) return { installed: false, version: null, extras: { code: false, ml: false } };
  try {
    const out = execFileSync(py, ["-m", "pip", "list", "--format=json", "--disable-pip-version-check"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: HEADROOM_PIP_TIMEOUT_MS,
      env: headroomRuntimeEnv(),
    }).toString();
    const packages = JSON.parse(out);
    const names = new Set(packages.map((p) => String(p.name || "").toLowerCase()));
    const installed = names.has("headroom-ai");
    if (!installed) return { installed: false, version: null, extras: { code: false, ml: false } };
    const version = packages.find((p) => p.name?.toLowerCase() === "headroom-ai")?.version || null;
    const extras = {};
    for (const extra of HEADROOM_COMPRESSION_EXTRAS) {
      extras[extra] = EXTRA_MARKERS[extra].every((m) => names.has(m));
    }
    return { installed: true, version, extras };
  } catch {
    return { installed: false, version: null, extras: { code: false, ml: false } };
  }
}
