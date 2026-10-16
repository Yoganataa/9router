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
    const bootstrap = globalThis.__ninerouterHeadroomBootstrapState || {
      status: settings.headroomEnabled === true ? "not-started" : "disabled",
      missingExtras: [],
      warning: null,
    };
    return NextResponse.json({ ...status, url, managedPid, bootstrap });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
