import "server-only";

import { cookies } from "next/headers";
import { localRequestMode } from "@/lib/requests/availability";
import { publicPrivacyNotice } from "@/lib/requests/public-information";
import { finderPreferenceCookie } from "./finder-cookie";

export function finderAttributionEnabled() {
  return process.env.EDGEY_FINDER_ATTRIBUTION_ENABLED === "true" && (localRequestMode() || Boolean(publicPrivacyNotice()));
}

export async function finderAttributionAllowed() {
  return finderAttributionEnabled() && (await cookies()).get(finderPreferenceCookie)?.value === "yes";
}
