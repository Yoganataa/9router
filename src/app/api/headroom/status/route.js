import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { DEFAULT_HEADROOM_URL, getHeadroomStatus } from "@/lib/headroom/detect";
import { getManagedPid } from "@/lib/headroom/process";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
    const status = await getHeadroomStatus(url);
    const managedPid = getManagedPid();
    let bootstrap = globalThis.__ninerouterHeadroomBootstrapState || {
      status: settings.headroomEnabled === true ? "not-started" : "disabled",
      missingExtras: [],
      warning: null,
    };

    // If an operator manually installs a previously missing extra and the
    // managed proxy is restarted successfully, clear stale degraded status.
    const configuredExtras = [
      ...(settings.headroomCodeAware === true ? ["code"] : []),
      ...(settings.headroomKompress !== false ? ["ml"] : []),
    ];
    if (
      managedPid
      && status.running
      && status.installed
      && settings.headroomEnabled === true
      && configuredExtras.every((extra) => status.extras?.[extra] === true)
      && bootstrap.status === "degraded"
      && Array.isArray(bootstrap.missingExtras)
      && bootstrap.missingExtras.length > 0
    ) {
      bootstrap = {
        ...bootstrap,
        status: "ready",
        missingExtras: [],
        warning: null,
        updatedAt: Date.now(),
      };
      globalThis.__ninerouterHeadroomBootstrapState = bootstrap;
    }

    return NextResponse.json({ ...status, url, managedPid, bootstrap });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
