"use client";

import { useEffect } from "react";
import { finderCookie, finderCookieAge, finderCookiePath, finderPreferenceCookie } from "@/lib/commercial/finder-cookie";

export function FinderAttribution({ eventId }: { eventId: string }) {
  useEffect(() => {
    if (!document.cookie.split(";").some((entry) => entry.trim() === `${finderPreferenceCookie}=yes`)) return;
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${finderCookie}=${eventId}; Path=${finderCookiePath}; Max-Age=${finderCookieAge}; SameSite=Strict${secure}`;
  }, [eventId]);
  return null;
}
