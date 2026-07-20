# signal-engine

Track B of Carriers On Notice. Collectors and a job pipeline that run on
Cloudflare Workers cron triggers. It gathers public evidence about wireless
carrier promotional credit practices, stores raw archives, and writes structured
records for Track C to classify. Everything here fits the Cloudflare free tier.

## Architecture (ten lines)

1. One Worker. Two cron triggers. The `scheduled` handler branches on the cron string.
2. `*/5 * * * *` drains the job queue. `0 * * * *` is an hourly dispatcher that kicks collectors by UTC hour.
3. D1 holds records, jobs, terms snapshots, terms diffs, and a sources registry.
4. R2 holds raw archives: downloaded arbitration files and captured terms HTML.
5. KV holds config and small cache state. Cursors live in the sources table.
6. Jobs are the backbone. Collectors write work rows. Stage workers claim and process them.
7. Claims are atomic per row. Failures retry with backoff. After max attempts a job dead-letters.
8. Everything is idempotent. Records dedupe on a natural key. Jobs dedupe on (type, key). Both use INSERT OR IGNORE.
9. Collectors: FTC RSS, AAA/JAMS files, terms snapshotter, phase 2 official records (SEC EDGAR, FCC Socrata, FCC ECFS, CA AG), a news radar (Google News, GDELT), and phase 3 social listeners (Bluesky, Hacker News) with deletion honoring.
10. Track C classifies records (deterministic then AI), corroborates across sources, builds record-to-record links, and publishes aggregates to R2 for Track E. xlsx parsing runs in GitHub Actions.

## What ships vs what is deferred

- FTC RSS: fully in the Worker. Fetch both feeds, parse, dedupe by link, write records.
- AAA and JAMS: the Worker resolves the current file link, downloads to R2, and enqueues a parse job. This is I/O, not CPU, so it fits.
- Arbitration parse: CSV is parsed inline in the Worker. xlsx is deferred. The Worker sniffs the first two bytes. A zip (xlsx starts with `PK`) is left in R2 and the parse job completes as "deferred". The real xlsx parse runs in CI (`scripts/parse-xlsx.mjs`, driven by `.github/workflows/parse-arb.yml`) using `exceljs`, and writes carrier rows back to D1 over the HTTP query API. This path is honest: the Worker never parses xlsx.
- Terms snapshotter: fully in the Worker. Fetch each target, store HTML to R2, hash normalized text, write a snapshot, and write a diff row when the hash changed. It also fires a Wayback Save Page Now request per capture and skips cleanly if the SPN secrets are unset.

## Phase 2 collectors (official records and news radar)

All of these read their targets and enable flags from the `sources` table. On
first deploy only FTC and CA AG are enabled. The API collectors are seeded
disabled so nothing hits an external API before you turn it on. Each holds its
incremental position in the source `cursor` column, and each caps how many rows
it writes per run to stay under the D1 per-invocation query cap and the CPU
budget. The cron cadence walks the backlog over many runs.

- SEC EDGAR full-text search (`sec_edgar`, off by default). Resolves the CIKs for T, VZ, and TMUS once and caches them in the cursor, then polls the FTS API for filings matching a rotating promo phrase, incremental by file date. Requires `SEC_USER_AGENT` ("CompanyName email"); skips if unset. CIK resolution uses a targeted regex over `company_tickers.json` instead of parsing the whole file, to stay off the CPU limit.
- FCC consumer complaints via Socrata (`fcc_socrata`, off by default). Incremental by `ticket_created`, filtered to `issue_type='Phone'`. Stores city, state, zip, issue, method, and date. This dataset has no carrier field, so `carrier` stays null and `vetting_status` stays `single_source`. These feed map aggregates, never per-carrier counts. Optional `SOCRATA_APP_TOKEN` raises the throttle; works without it.
- FCC ECFS filings (`fcc_ecfs`, off by default). Polls by promo keyword, incremental by `date_received`. Requires `ECFS_API_KEY` (api.data.gov, 1000/hr); skips if unset. Guardrail: filer names are stored only for organizations. If a filer looks like a private individual the record keeps the filing id and a neutral excerpt but not the name, and never the raw comment body. When in doubt, no name.
- California AG news RSS (`ca_ag_rss`, on by default). Reuses the RSS parser. Reads from source kind `ag_rss` so the FTC collector never grabs it. Only items that match the taxonomy (a carrier or a promo-credit term) become records.
- News radar: Google News RSS (`news_google`, off) and GDELT DOC 2.0 (`news_gdelt`, off). Discovery only. Stores headline, source domain, date, and link. Never article bodies. Records carry lead source ids so Track C treats them as leads, never as verified counts. GDELT is paced and 429-aware: on a 429 the client waits for `Retry-After` before retrying.

## Phase 3 collectors (social listeners with deletion honoring)

Both are keyless public reads, seeded disabled, polled once a day per phrase
bundle. They are leads and aggregate-count material only (`single_source`).

- Bluesky (`bluesky`, off by default). Public `searchPosts`. Privacy rule: we store the post AT-URI (the canonical post id and our re-resolution key) and nothing about the author. No handle, no display name, no separate DID field. The AT-URI necessarily contains the author DID; that is the one place it lives. We store the AT-URI as both the dedupe key and the source pointer and do not derive or store a `bsky.app/profile/<did>` permalink, so nothing copies the DID into a second field. Track E builds the human link on demand with `blueskyPermalink()`.
- Hacker News (`hackernews`, off by default). Algolia `search_by_date`, stories and comments. We store the objectID (our re-resolution key), the `item?id=` permalink (which carries no username), the date, and a trimmed, HTML-stripped excerpt. The author username is never stored.

### Deletion honoring and the weekly guarantee

A firehose consumer does not fit cron-driven free Workers, so deletions are
honored by scheduled purge sweeps that re-resolve stored posts and hard-delete
any that no longer resolve. Purged means deleted from D1, not flagged. Both
sweeps run on the existing hourly trigger and are no-ops when a source has no
stored records.

- Bluesky: `app.bsky.feed.getPosts` resolves 25 URIs per call. Each sweep checks up to 50 URIs (2 calls). At 168 sweeps/week that re-checks 8,400 records/week, oldest-checked first, so every stored Bluesky record is re-resolved at least weekly while the stored count stays under that. A URI absent from the response is deleted or taken down and its record is removed.
- Hacker News: the Algolia items endpoint is one call per id. Each sweep checks up to 20 ids. At 168 sweeps/week that re-checks 3,360 records/week. A 404 or `deleted: true` removes the record.
- Safety: a transient fetch failure or a non-200, non-404 status never counts as gone, so we never delete on doubt. The full math is in the comments of each purge module.

### Publishable aggregate

The view `v_carrier_mentions_monthly` (migration 0003) produces mentions per
carrier per month per source, counting only rows that currently exist. Because
the purge jobs hard-delete removed posts, the count stays honest. Read it with
`getCarrierMentionsMonthly()`. This is what Track E's methodology page points at.

## Track C: classification and connection

Four jobs (`classify`, `corroborate`, `link`, `publish`) enqueued hourly and run
by the `*/5` job runner in small bounded batches. Each is capped so several can
share one invocation without breaching the 50-queries-per-invocation free limit.

### Classification

A deterministic pass runs first, using the taxonomy matchers. When exactly one
carrier is implied (by a marketing pattern or a promo-name literal) it fills
`carrier`, `promo_name`, and `alleged_issue` and sets `confidence` to 0.95, never
1.0. Machine tagging is not verification, and we stay honest about that. Anything
ambiguous (more than one carrier) or empty goes to the AI stage.

The AI stage sits behind a `Classifier` interface with two implementations. The
default is Workers AI on a free-tier model. The alternative is Anthropic
`claude-haiku-4-5` through Cloudflare AI Gateway (`ANTHROPIC_API_KEY`, plus
`CF_ACCOUNT_ID` and `AI_GATEWAY_ID` in config); it is a COST FLAG and off by
default. Both implementations fail safe: on any error they return a null,
zero-confidence result so the record is queued for review, never mislabeled.

### Confidence routing (vetting is not confidence)

`CONFIDENCE_BAR` (config, default 0.7) routes each classified record. At or above
the bar, fields are written and `review_status` becomes `cleared`. Below the bar,
fields are still written but `review_status` becomes `queued` with a
`review_reason`, so nothing low-confidence feeds anything public.

Guardrail: the classifier never touches `vetting_status`. Machine confidence is
not vetting. A record stays `single_source` until the corroboration pass or a
human upgrades it. Confidence and vetting are separate axes on purpose.

### Corroboration rule

The `corroborate` job upgrades `vetting_status` from `single_source` to
`corroborated` when independent sources agree: the same carrier plus the same
`alleged_issue` (or the same `promo_name`) reported by two or more DIFFERENT
`source_id`s within a 90 day window. The same source reporting twice does not
count. `verified_primary` is never set by machine; only a human marks that.

### Connection layer

The `link` job builds record-to-record links (migration 0004, `links` table)
incrementally by a KV cursor, capped per run. Link types are exactly the
documented rabbit-hole kinds: `same_carrier_promo`, `same_carrier_issue_window`
(90 days), `same_promo_terms_language` (a shared promo name that also appears in a
terms-snapshot diff), and `same_claim_type`. Each row stores a plain-text `basis`
so Track E can show why two dots connect. `record_id_a` is always the smaller id,
so a pair is stored once, and `UNIQUE(record_id_a, record_id_b, link_type)` keeps
re-runs idempotent.

### Aggregates publisher

The `publish` job writes pre-aggregated JSON to R2 for Track E, deterministic
names, overwritten each run. Core files every run, drill-down files spread across
runs by cursor:

- `aggregates/map.json`: counts by state and by zip, built from the FCC monthly aggregates table (complaint concentration by place, not per-carrier).
- `aggregates/mentions.json`: the monthly carrier mentions view.
- `aggregates/totals.json`: totals, including a strict verified count that is `corroborated` plus `verified_primary` only.
- `aggregates/hotspots.json`: ranked hot spots for the map flames (see below).
- `aggregates/links.json`: the thread graph, nodes are record ids, edges carry `link_type` and `basis`, only displayable records.
- `aggregates/states/{XX}.json`: per-state drill-down (monthly trend, top issues, records list). A few states per run, walked by cursor.
- `aggregates/records/{id}.json`: per-record citation block. A few per run, walked by cursor.

Privacy: the per-state records list, per-record files, and the link graph expose
only records that are `cleared` AND `corroborated`-or-better. Excerpts are never
included. A Bluesky `source_url` is converted to its derived permalink so no raw
AT-URI is published. The public site reads these files, so they carry counts,
locations, and citation fields only, never social post text or author data.

## Historical backfill

Everything here is additive and ships idle. Nothing runs until you trigger it,
and the collectors added earlier keep working unchanged. Each backfill job does
one small bounded batch and re-enqueues a continuation while work remains, so the
`*/5` runner walks the history in chunks that fit the free CPU and 50-query
budgets.

- `arb_backfill`: one-shot. Forces a fresh AAA and JAMS download and parse regardless of cursor. The quarterly files carry about five years of history by law, so one full parse is the backfill. The xlsx parse still goes through the GitHub Actions escape hatch.
- `ftc_backfill`: pages backward through the FTC press-release listing, one page per run, stops at a configurable earliest date (`FTC_BACKFILL_EARLIEST`, default 2015-01-01). Dates are read from the press-release URL path, which is robust. Filters to telecom and wireless matters. Records get `record_date` from the item date.
- `courtlistener_backfill`: CourtListener v4 search within the free rate. A per-day budget counter in KV (`COURTLISTENER_DAILY`, default 125) is spent before each call; the walker stops when the day is exhausted and resumes tomorrow from the cursor. Stores docket-level records: court, case name, date filed, docket number, source URL. Optional `COURTLISTENER_TOKEN` raises limits.
- `fcc_aggregate_backfill`: THE architecture decision. We do not store row-level FCC complaints. Socrata group-by queries pull monthly counts by state and by top zips for `issue_type=Phone`, walking month cursors from 2014-11 forward into `fcc_monthly_aggregates`. The month grouping uses `date_trunc_ym(ticket_created)`, a documented SoQL function (verified at https://dev.socrata.com/docs/functions/date_trunc_ym.html, captured 2026-07-20). The publisher map layer reads this table.
- `wayback_backfill`: for each real terms target, queries the Wayback CDX API (matchType=prefix, collapse=digest, from=2019), stores one `terms_snapshots` row per distinct capture, and diffs consecutive captures the way live snapshots do. Terms targets are still placeholders, so this is a no-op until real URLs are seeded. Backfill snapshot rows carry an `archive_url` and a `wayback:<timestamp>` sentinel `r2_key` (the deployed column is NOT NULL; the sentinel means no local R2 object, archived remotely).

### Hot spots

`aggregates/hotspots.json` ranks states by complaint concentration from
`fcc_monthly_aggregates` boosted by vetted-record density, top N with an
intensity score (normalized to the hottest state) and a plain-text basis. The
map's flames read this file instead of computing client-side.

### Backfill runbook (paste in your terminal)

Backfills are off until triggered. Enable the source rows you need first, then
kick a backfill. Replace `$ADMIN_TOKEN` with the secret you set. The deployed
host is `signal-engine.carriersonnotice.workers.dev`.

```sh
# Enable the backfill sources you want (courtlistener and fcc_aggregate; ftc_backfill).
npx wrangler d1 execute signal_engine --remote \
  --command "UPDATE sources SET enabled=1 WHERE id IN ('ftc_backfill','courtlistener','fcc_aggregate')"

# Optional config before starting (all have code defaults):
npx wrangler kv key put --binding CONFIG "config:FTC_BACKFILL_EARLIEST" "2015-01-01"
npx wrangler kv key put --binding CONFIG "config:FCC_AGG_EARLIEST" "2014-11"
npx wrangler kv key put --binding CONFIG "config:COURTLISTENER_DAILY" "125"

# Trigger each backfill (enqueues the first job; the runner walks the rest):
H="https://signal-engine.carriersonnotice.workers.dev"
curl -H "authorization: Bearer $ADMIN_TOKEN" "$H/run?task=arb_backfill"
curl -H "authorization: Bearer $ADMIN_TOKEN" "$H/run?task=ftc_backfill"
curl -H "authorization: Bearer $ADMIN_TOKEN" "$H/run?task=courtlistener_backfill"
curl -H "authorization: Bearer $ADMIN_TOKEN" "$H/run?task=fcc_aggregate_backfill"
# wayback_backfill is a no-op until real terms URLs are seeded in the sources table.
```

To reset a backfill and re-run it, clear its cursor and re-trigger:

```sh
npx wrangler kv key delete --binding CONFIG "cursor:fcc_agg_month"
npx wrangler kv key delete --binding CONFIG "cursor:ftc_backfill_page"
npx wrangler kv key delete --binding CONFIG "cursor:courtlistener"
```

### GitHub Actions escape hatch

The arbitration xlsx parse already runs in Actions (`.github/workflows/parse-arb.yml`).
The FTC and CDX walkers are light enough to run inside the Worker, so no new
Actions workflow was added. If a real FTC listing page or a very long CDX history
turns out to exceed the Worker CPU budget in practice, the same escape-hatch
pattern (a `scripts/*.mjs` walker plus a `workflow_dispatch` job that writes back
to D1 over the HTTP API) is the fallback. OPEN ITEM for Michael: Actions requires
the public GitHub repo to exist; it does not yet.

## Why the CPU limit drives the design

The Workers free plan gives 10 ms of CPU per invocation. That is the hard
constraint behind every chunking choice: the job runner claims a small batch
(5) per cron tick, the RSS reader is a narrow regex parser instead of a full XML
library, the terms diff is a bounded LCS that bails to a coarse diff on large
input, and xlsx parsing is pushed out to CI entirely. When a choice risked the
budget, the smaller chunk won.

## Deploy from zero

You need a Cloudflare account for this project. It is not created yet. See
`../build-plan.md` step zero: a new Cloudflare account for this project only,
separate from the Stride gateway account, same email through the account
switcher, zero cost.

```sh
# 0. Install deps.
npm install

# 1. Log in with the project account.
npx wrangler login

# 2. Create D1. Copy the printed database_id into wrangler.jsonc (d1_databases[0].database_id).
npx wrangler d1 create signal_engine

# 3. Create the R2 bucket named in wrangler.jsonc.
npx wrangler r2 bucket create signal-engine-raw

# 4. Create the KV namespace. Copy the printed id into wrangler.jsonc (kv_namespaces[0].id).
npx wrangler kv namespace create CONFIG

# 5. Apply the schema.
npx wrangler d1 migrations apply signal_engine --remote

# 6. Set secrets (see names below). The last three are for phase 2 collectors
#    and only matter once you enable those sources.
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put WAYBACK_ACCESS_KEY
npx wrangler secret put WAYBACK_SECRET_KEY
npx wrangler secret put SEC_USER_AGENT
npx wrangler secret put ECFS_API_KEY
npx wrangler secret put SOCRATA_APP_TOKEN   # optional

# 7. Deploy.
npx wrangler deploy
```

Local development uses `npx wrangler dev` and `npm run migrate:local`.

### Secret names

Worker secrets, set with `wrangler secret put`. None are in code.

- `ADMIN_TOKEN`. Guards the manual `/run` trigger endpoint. Send it as `Authorization: Bearer <token>`.
- `WAYBACK_ACCESS_KEY`. Save Page Now S3 access key from an authenticated archive.org account.
- `WAYBACK_SECRET_KEY`. The matching SPN secret. If either Wayback secret is unset, archive-at-capture is skipped and collection still runs.
- `SEC_USER_AGENT`. SEC fair-access User-Agent, format "CompanyName email". Required by SEC policy. No built-in default that looks real. If unset, the EDGAR collector skips.
- `ECFS_API_KEY`. api.data.gov key for FCC ECFS (1000 requests/hour). If unset, the ECFS collector skips.
- `SOCRATA_APP_TOKEN`. Optional. Raises the FCC Socrata throttle. The collector works without it.

Phase 3 social listeners (Bluesky, Hacker News) are keyless public reads and need no secrets.

- `ANTHROPIC_API_KEY`. Optional, Track C. Only needed if you switch the classifier to the Haiku path (`CLASSIFIER=haiku` plus `CF_ACCOUNT_ID` and `AI_GATEWAY_ID` in config). COST FLAG: Haiku bills per token. The default classifier is Workers AI and needs no key.
- `COURTLISTENER_TOKEN`. Optional. Raises CourtListener rate limits. The backfill works without it, inside the free 125/day budget.

GitHub Actions secrets for the xlsx escape hatch (repo settings, not wrangler):

- `CLOUDFLARE_API_TOKEN`. Token with D1 edit on the project account.
- `CLOUDFLARE_ACCOUNT_ID`.
- `D1_DATABASE_ID`. The id from step 2.

### Deploy-day config to fill in

- `wrangler.jsonc`: `database_id` and the KV `id` (steps 2 and 4).
- Terms targets: the `sources` table seeds AT&T, Verizon, and T-Mobile terms rows with placeholder URLs (`REPLACE_WITH_REAL_TERMS_URL`). The snapshotter skips any row still holding a placeholder. Update them with real promo/offer-terms URLs once chosen:
  ```sh
  npx wrangler d1 execute signal_engine --remote \
    --command "UPDATE sources SET url='https://...' WHERE id='terms_att_promo'"
  ```
- Enable phase 2 API sources once their secrets are set. They ship disabled so nothing hits an API on first deploy:
  ```sh
  npx wrangler d1 execute signal_engine --remote \
    --command "UPDATE sources SET enabled=1 WHERE id IN ('sec_edgar','fcc_socrata','fcc_ecfs','news_google','news_gdelt')"
  ```
- Enable phase 3 social listeners (keyless, no secrets needed):
  ```sh
  npx wrangler d1 execute signal_engine --remote \
    --command "UPDATE sources SET enabled=1 WHERE id IN ('bluesky','hackernews')"
  ```
- Confirm the FCC Socrata column names on the live dataset (`city`, `state`, `zip`, `issue_type`, `ticket_created`, method field). The collector reads them defensively but assumes these names.
- Track C config lives in KV under `config:<key>`, all with code defaults so the Worker runs before anything is set. To change one:
  ```sh
  npx wrangler kv key put --binding CONFIG "config:CONFIDENCE_BAR" "0.7"
  # CLASSIFIER=workers_ai (default) or haiku
  # For the Haiku path also set config:CF_ACCOUNT_ID and config:AI_GATEWAY_ID
  ```

## Manual trigger

With `ADMIN_TOKEN` set you can run one collector without waiting for cron:

```sh
curl -H "authorization: Bearer $ADMIN_TOKEN" \
  "https://signal-engine.<subdomain>.workers.dev/run?task=ftc"
# task = ftc | arb | terms | caag | edgar | socrata | ecfs | news | bsky | hn
#      | purge | classify | corroborate | link | publish | jobs
#      | arb_backfill | ftc_backfill | courtlistener_backfill
#      | fcc_aggregate_backfill | wayback_backfill
```

`GET /health` returns service status with no auth.

## Free-tier envelope

The whole design sits well inside the free limits. The job runner claims 5 jobs
every 5 minutes (288 ticks/day), so at most 1,440 job runs/day plus a handful of
collector runs. That is a rounding error against the 100,000 requests/day
Workers limit. R2 stores a handful of files per day. KV is barely used.

Two limits shape the collectors directly:

- D1 allows 50 queries per Worker invocation on the free plan. Each phase 2 collector caps how many records it writes per run (EDGAR and ECFS 20, Socrata and news 25) so a single invocation stays well under that. The cursor resumes on the next run.
- The 5 cron triggers cap. We still use only 2 and branch on UTC hour inside the handler, which leaves 3 for later phases.

Per-source rate discipline: SEC stays far under its 10 req/sec fair-access rule
(a few requests per day). ECFS stays under the api.data.gov 1000/hr cap (one
keyword query per day). GDELT is held to its 1-request-per-5-seconds rule by
making one request per run and honoring `Retry-After` on a 429. Google News and
the AG feed are polled once a day.

### Verified current free-tier limits

Fetched from the live Cloudflare docs on 2026-07-20. Not from memory. Re-verify
before deploy day.

**Workers Free** (https://developers.cloudflare.com/workers/platform/limits/, captured 2026-07-20)
- 100,000 requests / day
- 10 ms CPU time per invocation
- 5 Cron Triggers per account
- 50 subrequests per request
- 128 MB memory per isolate

**D1 Free** (https://developers.cloudflare.com/d1/platform/pricing/ and https://developers.cloudflare.com/d1/platform/limits/, captured 2026-07-20)
- 5 million rows read / day
- 100,000 rows written / day
- 5 GB storage total
- 500 MB maximum database size
- 10 databases per account
- 50 queries per Worker invocation

**R2 Free** (https://developers.cloudflare.com/r2/pricing/, captured 2026-07-20)
- 10 GB-month storage
- 1 million Class A operations / month
- 10 million Class B operations / month
- Egress: free

**KV Free** (https://developers.cloudflare.com/kv/platform/limits/, captured 2026-07-20)
- 100,000 reads / day
- 1,000 writes / day (to different keys)
- 1 GB storage
- 25 MiB maximum value size
- 512 byte maximum key size

**Workers AI Free** (https://developers.cloudflare.com/workers-ai/platform/pricing/, captured 2026-07-20)
- 10,000 Neurons per day at no charge, resets daily at 00:00 UTC
- Billed in Neurons; beyond the free allocation it is $0.011 per 1,000 Neurons on the Paid plan
- Default classifier model: `@cf/meta/llama-3.2-1b-instruct` (small instruct model, https://developers.cloudflare.com/workers-ai/models/, captured 2026-07-20)

## COST FLAGS

Nothing in this repo spends money. These are the lines not to cross without a decision.

- **Workers Paid plan.** Only if collection volume outgrows the free job pattern. The 10 ms CPU limit, the D1 50-queries-per-invocation cap, and 100,000 requests/day are the tripwires. Not needed at current volume; the per-run record caps keep us clear.
- **Cloudflare Queues.** Paid. We deliberately do not use them. The D1 job table replaces them.
- **Logpush.** Paid. We use free Workers observability instead (`observability.enabled` in wrangler.jsonc).
- **exceljs.** Used only by the CI escape hatch, never bundled into the Worker. GitHub Actions is free for this workload. No runtime cost.
- **Anthropic Haiku classifier.** COST FLAG. The `HaikuClassifier` path (`CLASSIFIER=haiku`) bills per token through Cloudflare AI Gateway. Off by default. The default classifier is Workers AI, which is free up to 10,000 Neurons/day. A tiny classification call is a small number of Neurons, so at collector volumes the default path stays inside the free allocation. If daily classification volume ever approaches 10,000 Neurons, that is the tripwire to watch before enabling Haiku or a paid plan.
- **Domain registration.** Not this repo, but flagged in `../build-plan.md`: carriersonnotice.com through Cloudflare Registrar, roughly ten dollars a year at cost. Confirm the exact price at purchase before paying.

## Data rules honored in the schema

- Every record stores `source_url`, `capture_date`, and `excerpt`. Terms snapshots store the URL, r2 key, hash, and capture time.
- Location columns are `loc_city`, `loc_state`, `loc_zip` only. No street address. No person.
- No username or complainant identity fields exist. Records aggregate, they do not profile.
- `vetting_status` defaults to `single_source`. Only `verified_primary` and `corroborated` may feed public numbers. Track C sets these.
- Archive-at-capture: Wayback SPN plus the local R2 snapshot on every terms capture and file download.
- ECFS filer names are stored only for organizations. Individual filers keep the filing id and a neutral excerpt, never the name, never the raw comment body. When in doubt, no name.
- The FCC Socrata dataset has no carrier field. Those rows keep `carrier` null and `single_source` vetting and never become per-carrier counts.
- News radar records are discovery leads (`news_google`, `news_gdelt` source ids). Headline, domain, date, link only. Never article bodies.
- Social listeners store no author identity. Bluesky keeps only the AT-URI (author DID lives there and nowhere else, never as a separate handle/name/DID field). Hacker News keeps no username. Both are `single_source` leads.
- Deletion honoring is real deletion: purge sweeps hard-delete records whose source post no longer resolves, every stored social record re-checked at least weekly. The `v_carrier_mentions_monthly` aggregate therefore counts only posts that still exist.
- Confidence is not vetting. The classifier writes `confidence` and routes on it, but never changes `vetting_status`. Only corroboration (machine) or a human upgrades vetting. `verified_primary` is human-only.
- Published aggregates carry counts and locations only. No excerpts, no author data, nothing from a social record body reaches R2 or the public site.
- FCC complaint data is stored as monthly aggregates only, never row-level. There is no carrier field in that data, so it is complaint concentration by place, never per-carrier.
- The rabbit-hole drill-down files (per-state, per-record, link graph) expose only cleared, corroborated-or-better records, never excerpts, and convert Bluesky AT-URIs to derived permalinks.

## Tests

```sh
npm test
```

Runs under vitest with `@cloudflare/vitest-pool-workers`, so the D1-backed tests
execute against a real local D1 in the Workers runtime. Coverage: job claim,
retry, dead-letter, job and record dedupe, RSS parse, feed link dedupe, CSV
parse, taxonomy matching, and diff detection (phase 1); plus EDGAR CIK
resolution and hit parsing, Socrata incremental cursor and dedupe keys, the ECFS
individual-vs-organization filer rule, GDELT parsing, the 429 Retry-After path,
and a D1-backed news record-shape test (phase 2); plus Bluesky and HN search
parsing, permalink derivation, the no-author-fields rule asserted on inserted
rows, purge logic against local D1 (resolved kept, missing purged, transient
failures never purged), and the aggregate view counts before and after deletion
(phase 3); plus the deterministic tagger (single carrier, promo-literal inference,
multi-carrier ambiguity routing, empty), model-output coercion, the corroboration
window rule, link-type derivation, and D1-backed tests for confidence routing at
and below the bar (with vetting left untouched), corroboration (two sources
upgrade, same source twice does not, never verified_primary), link building (each
type, basis text, unique constraint), and the publisher output shape with the
cleared-or-better filter and strict verified count (Track C); plus the FCC SoQL
query construction, month cursor walking, the CourtListener query builder and
docket parse, the FTC listing parse (date from URL), the Wayback CDX parse and
snapshot-diff chaining, hotspot ranking, and D1-backed tests for the daily budget
counter stop/resume, the CourtListener budget stop and docket insert, the map
built from FCC aggregates, and the per-state and per-record JSON plus link graph
with the privacy filter asserted (no social excerpts, permalink conversion,
displayable-only) (backfill and rabbit-hole layer). As of 2026-07-20 all 87 tests
pass on this machine (`vitest 4.1.10`, pool `0.18.6`, node 22).

Test bindings are declared inline in `vitest.config.ts` (D1, R2, KV) rather than
loaded from `wrangler.jsonc`, so the suite runs fully local. The production AI
binding is intentionally omitted from the test worker because Workers AI has no
local emulation; tests inject a stub classifier and never call AI.

## Layout

```
migrations/0001_init.sql     schema + seeded sources registry
migrations/0002_phase2_sources.sql  phase 2 source rows (API sources off by default)
migrations/0003_phase3_social.sql   social sources, last_checked_at, aggregate view
migrations/0004_track_c_links.sql   links table (record-to-record connections)
migrations/0005_backfill.sql        fcc_monthly_aggregates, backfill sources
src/index.ts                 scheduled + fetch entry, hourly dispatcher
src/runner.ts                claim a batch, dispatch to processors and backfills
src/db/jobs.ts               enqueue, claim, complete, retry/dead-letter
src/db/records.ts            record insert, sources read
src/db/social.ts             purge queue: due-for-recheck, bulk purge, mark-checked
src/db/aggregates.ts         v_carrier_mentions_monthly reader
src/db/fcc.ts                fcc_monthly_aggregates insert and readers
src/lib/rss.ts               regex feed reader
src/lib/diff.ts              normalize + bounded unified diff
src/lib/hash.ts              sha-256
src/lib/http.ts              fetch with 429 Retry-After, injectable for tests
src/lib/config.ts            KV-backed config, cursors, daily budget counter
src/lib/months.ts            month cursor helpers
src/lib/wayback.ts           Save Page Now, skips if unset
src/lib/taxonomy.ts          loads taxonomy.json, carrier/issue/promo matchers
src/collectors/ftc-rss.ts    FTC feed poller
src/collectors/arb.ts        AAA/JAMS file checkers
src/collectors/terms.ts      terms snapshotter + diff writer
src/collectors/ca-ag.ts      California AG RSS, taxonomy-filtered
src/collectors/edgar.ts      SEC EDGAR full-text search
src/collectors/socrata.ts    FCC consumer complaints (Socrata)
src/collectors/ecfs.ts       FCC ECFS filings, org-only filer names
src/collectors/news.ts       Google News + GDELT radar (leads)
src/collectors/bluesky.ts    Bluesky searchPosts, AT-URI only, no author
src/collectors/hackernews.ts HN Algolia search, no username
src/purge/bluesky-purge.ts   Bluesky deletion honoring (getPosts)
src/purge/hackernews-purge.ts HN deletion honoring (items endpoint)
src/classify/tagger.ts       deterministic taxonomy tagging
src/classify/classifier.ts   Classifier interface, Workers AI + Haiku + stub
src/classify/run.ts          classify job: deterministic + AI, confidence routing
src/classify/corroborate.ts  vetting upgrade when independent sources agree
src/classify/links.ts        record-to-record link builder
src/publish/publish.ts       aggregates + rabbit-hole files to R2
src/publish/hotspots.ts      hot spot ranking for the map flames
src/backfill/ftc-backfill.ts         FTC press-release history walker
src/backfill/courtlistener-backfill.ts CourtListener v4 search, budget-aware
src/backfill/fcc-aggregate-backfill.ts FCC monthly aggregates via Socrata group-by
src/backfill/wayback-backfill.ts     Wayback CDX capture history + diffs
src/processors/parse-file.ts CSV inline, xlsx deferred
scripts/parse-xlsx.mjs       CI escape hatch for xlsx
taxonomy.json                keyword taxonomy as data
```
