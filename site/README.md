# Carriers On Notice. Public site. Phase 1.

The public web app for the Carriers On Notice project. Static Astro site with one
interactive island, the US map. Built to the accepted Track E GUI brief.

Phase 1 is working code with sample data. It builds clean, indexes for search,
and runs with no server. It is not deployed and carries no real numbers yet.

## Stack

- Astro 5, static output. No SSR adapter. Zero JavaScript on every page except
  the map. The brief named Astro 6 as a re-pin-at-build target. The current
  stable major at build time is Astro 5.18, so this is pinned to Astro 5. Re-pin
  when Astro 6 is the stable major.
- D3 (d3-geo) plus TopoJSON (topojson-client) rendering an SVG choropleth. The
  map is the single island. The choropleth is server rendered at build time, so
  it is visible with no JavaScript, and the island enhances it.
- Pagefind for search. A static WASM index built after the Astro build. No
  server, no cost.
- Sitemap via @astrojs/sitemap. robots.txt in public.
- No analytics and no tracking in the site code. See deploy day items.

## Requirements

- Node 20 or newer (built and tested on Node 22).
- npm.

## Run

```
npm install
npm run dev
```

Dev server runs at http://localhost:4321. Note: search does not work in `dev`
because the Pagefind index is generated after the build. Use `build` plus
`preview` to test search.

## Build

```
npm run build
```

This runs `astro build` then `pagefind --site dist`. Output is in `./dist`,
including the Pagefind index under `./dist/pagefind`.

Other scripts:

- `npm run build:astro` builds without the Pagefind step.
- `npm run index` runs Pagefind against an existing `./dist`.
- `npm run check` runs `astro check` (types and diagnostics). Clean.
- `npm run preview` serves `./dist` locally for a production-like check.

## Environment variables

- `PUBLIC_TURNSTILE_SITE_KEY`. The Cloudflare Turnstile site key for the story
  form. In phase 1 the form renders a Turnstile placeholder only. Set this at
  deploy so the real widget can mount. It is a public site key, safe to expose.

No secrets live in this repo.

## Pages

- `/` home. Verified count from totals.json, fact vs commentary intro, a static
  (no JavaScript) map preview, and links to library, take action, tell.
- `/map` the interactive map island. State choropleth from map.json, flame hot
  spots, carrier and time filters, drill down side panel, a mirror data table,
  and all view state in the URL.
- `/library` and `/library/[slug]` the evidence library index and record
  template with the citation block pattern. 8 sample records.
- `/methodology` where every number comes from, the vetting ladder, the FCC no
  carrier name limit, and the social mention counting rule.
- `/corrections` the public corrections log (empty) plus the policy summary.
- `/take-action` the FCC complaint guide, the state AG link out explanation, and
  per carrier dispute stubs at `/take-action/att`, `/verizon`, `/tmobile`.
- `/tell` the story form with consent text and a Turnstile placeholder. Posts to
  `/api/submit`, a phase 1 stub page. Submit is disabled in phase 1.
- `/search` the Pagefind search UI.
- `/legal/*` the six Track I legal documents, linked in every footer with
  methodology and corrections.

## Data

The site reads three JSON files that match the shapes published by the pipeline
in `signal-engine/src/publish/publish.ts`:

- `public/aggregates/map.json` counts by state and by ZIP (MapAggregate).
- `public/aggregates/mentions.json` monthly carrier mentions (rows of
  CarrierMonthlyMention).
- `public/aggregates/totals.json` records, strict verified count, and the
  vetting breakdown (TotalsAggregate).

These are SAMPLE files with modest placeholder numbers. Every place they display
carries a SAMPLE badge. At launch, replace these three files with the real
aggregates the pipeline writes to R2, and remove the SAMPLE notices.

The map geometry is `public/data/us-states-10m.json`, copied from the `us-atlas`
package (public domain Census cartographic boundaries).

## Deploy later (not done in phase 1)

Target: Cloudflare Workers static assets serving `./dist` from the edge, free.

1. Add a Cloudflare Worker (or Pages) project pointed at the built `./dist`.
   Static output needs no Astro SSR adapter.
2. Wire the aggregates. Either copy the pipeline aggregates into
   `public/aggregates` at build, or serve them from R2 and point the site at
   those URLs. Keep the three shapes identical to publish.ts.
3. Stand up the write path. Replace the `/api/submit` stub with a Worker that
   verifies Turnstile, rate limits per IP with KV, and stores the story for
   human review. The form already posts to `/api/submit`.
4. Set `PUBLIC_TURNSTILE_SITE_KEY` and mount the real Turnstile widget script on
   `/tell`.

## Deploy day items

- Analytics. Add the Cloudflare Web Analytics snippet at deploy. It is cookieless
  and aggregate only. It is intentionally absent from the site code. Nothing else
  tracks anyone. No pixels, no per person attribution, no share analytics.
- Open Graph images. Phase 1 ships one placeholder at `public/og/placeholder.svg`.
  Generate real per page OG images (build time for stable pages, a workers-og
  Worker for dynamic map state shares) at deploy.
- Per carrier dispute addresses. The AT&T, Verizon, and T-Mobile dispute pages
  say "addresses being verified". Do not publish a notice of dispute address
  until it is confirmed from a primary source.
- Real numbers. Swap the sample aggregates for real data and remove every SAMPLE
  badge and notice. Do not launch with sample numbers unlabeled.
- Legal review. The six Track I documents are drafts for founder review. A lawyer
  should check them before launch.

## Guardrails honored in the code

- Facts and commentary are split. Documented practice is stated with a source.
  Reads are labeled commentary.
- The FCC map layer is labeled "wireless billing complaint concentration, all
  carriers" everywhere it appears. It is never shown per carrier, because the FCC
  dataset has no carrier name field. The carrier filter says it applies only to
  carrier tagged records.
- Every displayed record links to its public source, with a copyable citation.
- Only corroborated and verified primary records feed the public count. The
  header count is the strict verified count.
- Location is city, state, or ZIP only. No usernames, no personal identifiers.
- No em dashes anywhere in the repo, per the michael-voice rule.
- Dyslexia-friendly typography: sans-serif, generous line height and spacing,
  left aligned, short line lengths.
- The corrections page ships from day one and is linked in every footer.
- No tracking of any kind in the site code.

## Accessibility

- WCAG 2.2 AA intent. Skip link, landmarks, correct heading order.
- The map is keyboard reachable. Tab to a state, arrow keys move between states,
  Enter or Space opens the drill down. Flames are real SVG nodes, focusable and
  operable. Visible focus rings throughout.
- Colorblind safe sequential scale. Meaning is never carried by color alone.
  Values show in the panel and in a full data table that mirrors the map. The
  table is the screen reader path.
- `prefers-reduced-motion` is respected. No animated transitions when set.
- Theme aware. Light and dark both styled, with a data-theme override hook.
