// CI driver for the xlsx escape hatch. Queries D1 for the newest deferred
// parse_file job per provider (the Worker records the real file URL in the job
// payload when it downloads a new quarterly file), then runs parse-xlsx.mjs
// against that URL. Safe to re-run: records dedupe on the provider case id.
//
// Required env (GitHub Actions secrets):
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function d1Query(sql) {
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID } = process.env;
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !D1_DATABASE_ID) {
    throw new Error("Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors ?? data)}`);
  return data.result;
}

async function main() {
  const result = await d1Query(
    "SELECT payload FROM jobs WHERE type='parse_file' ORDER BY id DESC LIMIT 20"
  );
  const rows = result?.[0]?.results ?? [];
  const latestByProvider = new Map();
  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!payload?.provider || !payload?.sourceUrl) continue;
    if (!latestByProvider.has(payload.provider)) latestByProvider.set(payload.provider, payload);
  }

  if (latestByProvider.size === 0) {
    console.log("no parse_file jobs found; nothing to parse");
    return;
  }

  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "parse-xlsx.mjs");
  let failed = false;
  for (const [provider, payload] of latestByProvider) {
    console.log(`parsing ${provider}: ${payload.sourceUrl}`);
    const r = spawnSync("node", [script, payload.sourceUrl, provider], { stdio: "inherit" });
    if (r.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
