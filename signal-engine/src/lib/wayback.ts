import type { Env } from "../env.js";

// Wayback Save Page Now v2. Archive-at-capture. If SPN credentials are unset we
// skip and return null so a missing secret never breaks a collector run.
//
// Auth is the SPN2 S3-style header: `authorization: LOW <accesskey>:<secret>`.
// Get keys from an authenticated archive.org account (see README secret names).

export interface WaybackResult {
  submitted: boolean;
  jobId?: string;
  // Best-effort pointer. SPN is async; the real snapshot url resolves later.
  archiveUrl?: string;
}

export async function saveToWayback(env: Env, url: string): Promise<WaybackResult> {
  if (!env.WAYBACK_ACCESS_KEY || !env.WAYBACK_SECRET_KEY) {
    return { submitted: false };
  }
  try {
    const body = new URLSearchParams({ url, skip_first_archive: "1" });
    const res = await fetch("https://web.archive.org/save", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `LOW ${env.WAYBACK_ACCESS_KEY}:${env.WAYBACK_SECRET_KEY}`,
      },
      body,
    });
    if (!res.ok) return { submitted: false };
    const data = (await res.json().catch(() => ({}))) as { job_id?: string };
    // Best-effort durable pointer using the capture minute.
    const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return {
      submitted: true,
      jobId: data.job_id,
      archiveUrl: `https://web.archive.org/web/${ts}/${url}`,
    };
  } catch {
    return { submitted: false };
  }
}
