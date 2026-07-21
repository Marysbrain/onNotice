// Pull the published aggregates from R2 into public/aggregates/ so the Astro
// build bakes live numbers. Run before `npm run build`:
//
//   source ~/.con-cloudflare.env && node scripts/fetch-aggregates.mjs
//
// Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment
// (the CON-scoped token). Fails loudly rather than silently building with
// stale numbers.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUCKET = "signal-engine-raw";
const FILES = ["map.json", "mentions.json", "totals.json", "hotspots.json", "links.json"];

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "aggregates");
mkdirSync(outDir, { recursive: true });

if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID. source ~/.con-cloudflare.env first.");
  process.exit(1);
}

let failed = false;
for (const f of FILES) {
  const r = spawnSync(
    "npx",
    ["wrangler", "r2", "object", "get", `${BUCKET}/aggregates/${f}`, "--pipe", "--remote"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0 || !r.stdout.trim().startsWith("{")) {
    console.error(`FAILED aggregates/${f}: ${r.stderr?.slice(0, 200)}`);
    failed = true;
    continue;
  }
  // Round-trip so a truncated download can never overwrite a good file.
  const body = JSON.stringify(JSON.parse(r.stdout));
  writeFileSync(path.join(outDir, f), body);
  console.log(`aggregates/${f}: ${body.length} bytes`);
}
process.exit(failed ? 1 : 0);
