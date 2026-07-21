// Site worker. Two jobs only:
//   1. X-Robots-Tag noindex on workers.dev hosts, so staging never gets
//      indexed while the production domain stays clean.
//   2. POST /api/submit: the story form endpoint. Turnstile server
//      verification, then one insert into stories with review_status queued.
//      A human reviews everything; nothing publishes from here.
//
// PRIVACY: no IP address, no user agent, no cookies are stored. The optional
// contact field is never displayed anywhere.

const CARRIERS = new Set(["att", "verizon", "tmobile", "other"]);
const MAX_BODY = 32 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit") {
      return handleSubmit(request, env);
    }

    const res = await env.ASSETS.fetch(request);
    if (!url.hostname.endsWith(".workers.dev")) return res;
    const headers = new Headers(res.headers);
    headers.set("X-Robots-Tag", "noindex");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};

async function handleSubmit(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  // Submissions stay closed until the Turnstile secret exists. The form UI
  // says the same thing, so this is a backstop, not the primary message.
  if (!env.TURNSTILE_SECRET) {
    return redirect("/tell/?status=closed");
  }
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return new Response("Payload too large", { status: 413 });

  let form;
  try {
    form = await request.formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const token = str(form, "cf-turnstile-response", 4096);
  if (!token) return redirect("/tell/?status=human-check");

  const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token }),
  });
  const outcome = await verify.json().catch(() => ({ success: false }));
  if (!outcome.success) return redirect("/tell/?status=human-check");

  const whatHappened = str(form, "what_happened", 8000).trim();
  const agree = str(form, "agree", 8) === "on";
  if (!agree) return redirect("/tell/?status=consent");
  if (whatHappened.length < 20) return redirect("/tell/?status=too-short");

  const carrierRaw = str(form, "carrier", 16);
  const carrier = CARRIERS.has(carrierRaw) ? carrierRaw : null;
  const city = str(form, "city", 100).trim() || null;
  const stateRaw = str(form, "state", 2).trim().toUpperCase();
  const state = /^[A-Z]{2}$/.test(stateRaw) ? stateRaw : null;
  const zipRaw = str(form, "zip", 5).trim();
  const zip = /^\d{5}$/.test(zipRaw) ? zipRaw : null;
  const contact = str(form, "contact", 200).trim() || null;

  await env.DB.prepare(
    `INSERT INTO stories (what_happened, carrier, city, state, zip, contact, consent, review_status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'queued')`
  )
    .bind(whatHappened, carrier, city, state, zip, contact)
    .run();

  return redirect("/tell/thanks/");
}

function str(form, key, max) {
  const v = form.get(key);
  return typeof v === "string" ? v.slice(0, max) : "";
}

function redirect(to) {
  return new Response(null, { status: 303, headers: { location: to } });
}
