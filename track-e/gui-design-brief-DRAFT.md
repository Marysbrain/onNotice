# Track E GUI Design Brief (DRAFT)

Carriers On Notice public web app. Prepared 2026-07-20. All external claims carry a URL and capture date. Version numbers come from web search on 2026-07-20 and should be re-pinned at build time.

## One-screen summary (recommended stack)

1. Host: Cloudflare. Static HTML from the edge for free. A small Worker only for the parts that must run code.
2. Framework: Astro 6 with islands. Zero JavaScript by default. Ship JS only on the map page.
3. Map: D3 + TopoJSON rendering SVG. Chosen for accessibility and small bundle, not WebGL power.
4. Map escape hatch: MapLibre GL JS, only if ZIP-level density makes SVG too heavy. Not the default.
5. Search: Pagefind. Client-side WASM index built at build time. No server, no cost.
6. Share images: build-time Open Graph images for stable pages. A workers-og Worker only for dynamic map-state shares.
7. State in the URL: carrier, time window, geography, and zoom all live in query params. Every view is a deep link.
8. Progress: a collective movement dashboard. Counts of records, verified stories, documented term changes, and state coverage. No personal or filer leaderboards.
9. Trust: methodology link near every number, source link on every data point, corrections page in every footer.
10. Bots: reads open to crawlers, writes locked behind Cloudflare Turnstile plus Worker rate limiting.

COST FLAG: everything above fits Cloudflare and open-source free tiers. The only paid idea in this brief is the x402 appendix, which is a founder decision, not a recommendation.

---

## 1. Precedent scan

Seven named exemplars. Each proves one interaction pattern that works.

1. ProPublica Landline and Stateline. Open-source JavaScript that turns GeoJSON into browser SVG state and county choropleths. Proves that lightweight SVG maps beat heavy map engines for a national choropleth. Source: https://www.propublica.org/nerds/introducing-landline-and-stateline-two-tools-for-quick-vector-maps-in-your- (captured 2026-07-20).

2. ProPublica IRS audit-rate county map. A county choropleth that carries a hard finding without clutter. Proves color-encoded geography can deliver one takeaway at a glance. Source: https://www.propublica.org/nerds/mapping-state-millions (captured 2026-07-20).

3. NYT precinct-level 2024 election map. Deep zoom over 110,000+ precincts, with the underlying data published on GitHub. Proves deep drill-down plus open, citable source data as a single package. Sources: https://github.com/nytimes/presidential-precinct-map-2024 and https://github.com/nytimes/presidential-precinct-map-2024/blob/main/README.md (captured 2026-07-20).

4. CFPB Consumer Complaint Database. A searchable, filterable public complaint database where every record traces to a company response, backed by a public API. Proves filter plus per-record sourcing at scale. Sources: https://www.consumerfinance.gov/data-research/consumer-complaints/search/ and https://cfpb.github.io/api/ccdb/ (captured 2026-07-20).

5. FCC Consumer Complaints Data Center. Open informal-complaint data with city, state, and ZIP, published on an open-data portal. Proves the exact dataset shape we will map. Note the source-registry limit: this set has no carrier name field. Sources: https://www.fcc.gov/consumer-complaints-center-data and https://opendata.fcc.gov/Consumer/CGB-Consumer-Complaints-Data/3xyp-aqkj (captured 2026-07-20).

6. OpenSecrets Open Data. Citable records plus downloadable bulk data and a documented method. Proves that a public interface and a machine-access path can live side by side. Source: https://www.opensecrets.org/open-data (captured 2026-07-20).

7. USAFacts Viz Lab. Government data turned into one clear takeaway, with the source shown on the visual. Proves the number-plus-source-plus-method habit we want on every page. Source: https://usafacts.org/visualizations/ (captured 2026-07-20).

Also reviewed for machine-access precedent: GDELT, a large free open platform built for computing over the data. Source: https://www.gdeltproject.org/ (captured 2026-07-20).

---

## 2. Map layer recommendation

Primary: D3 + TopoJSON rendering SVG.

Escape hatch: MapLibre GL JS, only if ZIP-level rendering forces us off SVG.

Why D3 + TopoJSON wins for this app:

- Accessibility. Each state, county, or ZIP is a real DOM node. You can make it focusable, give it an ARIA label, and wire arrow-key movement. This is the strongest keyboard and screen-reader story of the four options. WebGL canvas maps hide geography inside one canvas element, which is hard to make WCAG 2.2 AA compliant. This matches the ProPublica SVG-map precedent in section 1.
- Bundle size. You load only the D3 modules you use plus a TopoJSON file. TopoJSON encodes shared borders once, so US shapes stay small. No tile engine ships to the browser.
- Zero server cost. The choropleth reads pre-aggregated JSON published by the pipeline. Pure static serving. No tile server, no map API key.
- Mobile touch. Tap to drill down works well. We do not need pinch-zoom over millions of points. Default view is state and county. ZIP detail loads only on drill-down.

Why not the others:

- MapLibre GL JS. WebGL vector map, 3-Clause BSD license, current release reported as 5.24.0. Great for smooth pan and zoom over large tilesets. Heavier bundle, needs vector tiles or large GeoJSON, and the a11y story is weaker. Keep it as the escape hatch if a full national ZIP choropleth in SVG gets too heavy. Sources: https://github.com/maplibre/maplibre-gl-js and https://www.npmjs.com/package/maplibre-gl (captured 2026-07-20).
- deck.gl. MIT license, current release reported as 9.3.6, WebGL2 and WebGPU. Built for millions of points and 3D. Overkill for a state and ZIP choropleth, and it inherits the canvas a11y problem. Source: https://github.com/visgl/deck.gl and https://www.npmjs.com/package/deck.gl (captured 2026-07-20).
- Plain SVG with no D3. Works, but you would rebuild the projection, the TopoJSON decode, and the color binning by hand. D3 gives you those for free and stays modular.

Close call: D3 + TopoJSON versus MapLibre GL JS. The deciding factors were the hard accessibility rule and zero-cost static serving, both of which favor SVG. If build-time testing shows a national ZIP choropleth in SVG janks on mid-range phones, switch the ZIP layer only to MapLibre and keep state and county in SVG.

UNVERIFIED: exact current version numbers above come from search summaries, not directly loaded release pages. Re-pin at build. The license facts (MapLibre 3-Clause BSD, deck.gl MIT) should be re-read from each LICENSE file before shipping.

---

## 3. Frontend stack recommendation

Primary: Astro 6 with islands.

Astro renders pages to static HTML and ships zero JavaScript by default. You add small interactive islands only where you need them. Official integrations cover React, Vue, Svelte, Solid, Preact, and Alpine. Source: https://docs.astro.build/en/concepts/islands/ and https://astro.build/ (captured 2026-07-20).

Why Astro over a heavier SPA:

- Performance. Most of this site is static content. Evidence library pages, methodology, corrections, and the take-action hub are documents. They should be HTML, not a React app. Astro ships them as HTML with no framework runtime.
- One heavy page, isolated. The map is the only rich interaction. With islands, the D3 map is a single island on one page. The rest of the site pays nothing for it.
- Maintenance cost. Fewer moving parts than a full SPA. No client router to maintain, no hydration of the whole tree. Content is Markdown, which suits a growing evidence library.
- SEO and citability. Static HTML is crawlable and stable, which section 7 needs for open read paths.

Why not a heavy SPA (Next.js, SvelteKit full app, or a React SPA):

- It ships a framework runtime to every visitor for pages that are just text.
- Client-side routing hurts crawlability and stable citation URLs unless you add SSR back, which adds cost and complexity.

Deployment note. Astro builds static by default. For static output on Cloudflare you do not need the SSR adapter. Serve the built `./dist` as Cloudflare Workers static assets, which serve from the edge for free. The Astro Cloudflare adapter is only needed if you add server rendering, and that adapter now targets Cloudflare Workers rather than Pages. Sources: https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/ and https://docs.astro.build/en/guides/deploy/cloudflare/ (captured 2026-07-20).

UNVERIFIED: Astro 6 (March 2026) comes from search summaries, not a directly loaded changelog. Re-pin the major version at build.

---

## 4. Interaction patterns

One short spec each.

### Map filtering by carrier and time

- Filter state lives in the URL query string: carrier, time window, geography level.
- The choropleth reads pre-aggregated JSON keyed by those filters. Changing a filter swaps or re-keys the JSON and recolors the SVG. No page reload.
- Hard data limit from the source-registry: the FCC complaint dataset has no carrier name field. So the carrier filter does not apply to the FCC layer. Label the FCC layer clearly as wireless billing complaint concentration, not per-carrier counts. Carrier filtering applies only to the library, litigation, and consented-story layers, where a carrier is on the record. Source: source-registry note (project skill).
- Time filter uses the capture date or event date already stored on every record.

### Drill-down from map to sourced records

- Click or keyboard-Enter on a geography opens a side panel.
- The panel lists the records behind that area. Each row shows the claim, the carrier if known, the source link, and the capture date.
- Each row links to the stable evidence-library URL for that record. No dead ends. Every colored area can be traced to its records.

### Sitewide search

- Recommendation: Pagefind. It builds a static search index at build time and runs the search in the browser with WebAssembly. No server, no cost, no infrastructure. Current release reported as 1.5.2. Sources: https://pagefind.app/ and https://github.com/Pagefind/pagefind (captured 2026-07-20).
- Why not a Worker search endpoint: it adds a running service, a rate-limit surface, and cost, to solve a problem the static index already solves. Keep search on the free static path.
- Scope: index the evidence library, methodology, corrections, and take-action pages so researchers can find any cited claim fast.

### Share mechanics

- Deep links. Every view is reconstructable from its URL. The map reads carrier, time, geography, and zoom from query params on load and restores the exact state. Copying the address bar shares that exact view.
- Open Graph images. Two paths:
  - Build time for stable pages (library records, methodology, corrections, per-carrier dispute pages). Generate the OG image during the Astro build. Free and fully cached.
  - A workers-og Worker only for dynamic map-state shares, where the image should reflect the chosen carrier, time, and geography. workers-og uses Satori to render HTML and CSS to an image at the edge with no headless browser. Sources: https://github.com/kvnang/workers-og and https://developers.cloudflare.com/pages/functions/plugins/vercel-og/ (captured 2026-07-20).
- COST FLAG: the OG Worker runs on the Cloudflare Workers free tier. Fine at expected volume. Watch request counts if a map view goes viral. Prefer build-time images wherever the view is stable.

### Citation block on every library page

- A fixed block pattern repeated on every evidence-library page.
- Fields: the claim, the source URL, the capture date, a short excerpt, an archive link, and a copyable citation string.
- This enforces the guardrail that every public claim traces to a record, and the source-registry rule that every displayed data point links to its public source. Sources: campaign-guardrails and source-registry notes (project skills).

---

## 5. Collective progress display

A single movement dashboard module. It shows movement, not people.

What it displays:

- Verified record count over time. An area or line chart of total verified records by month. The current running count is the headline number, and it also appears in the site header.
- Stories verified. A count of user-submitted stories that passed moderation and consent. Aggregate number only.
- Terms changes documented. A short timeline of documented changes to carrier promotion terms, each entry linking to its evidence record.
- State participation. How many states have at least one verified record. Shown as map coverage, a fill or an outline on states that have evidence, not a ranking.

How it stays inside the guardrail line:

- No personal leaderboards. No filer scoreboards. No count of who filed the most complaints. Nothing that ranks or names individuals.
- State participation is coverage, not competition. It answers where evidence exists, not which state is winning. States are not sorted into a league table.
- Every metric is a count of records or documented facts, never a count of filing activity by a person. This avoids any read that we are coordinating or gamifying complaint filing. Source: campaign-guardrails message discipline and data rules (project skill).
- Every number on the dashboard links to the methodology page that explains how it is counted, and the count only moves on verified and corroborated data. Source: source-registry note (project skill).

---

## 6. Accessibility and trust

Baseline: WCAG 2.2 AA.

Color and the choropleth:

- Use a colorblind-safe sequential scale. Viridis or Cividis, or a ColorBrewer palette marked colorblind safe. Avoid red-green. Source: https://colorblind.io/guides/data-visualization (captured 2026-07-20).
- Never encode meaning in color alone. Show the value in the tooltip, in the drill-down panel, and in a plain data table that mirrors the map. A reader who cannot see color still gets every number.

Keyboard and motion:

- The map is keyboard navigable. Tab reaches the map, arrow keys move between geographies, Enter opens the drill-down. This is possible because each geography is a real SVG DOM node (see section 2).
- Filters and the search box are standard focusable controls with visible focus rings.
- Respect prefers-reduced-motion. No animated zooms or transitions when that flag is set. Instant state changes only.

Typography for dyslexic readers:

- Sans-serif, larger base size, generous line height and letter spacing.
- Left-aligned text, never justified. Short line lengths. This matches how the founder reads and writes and helps all readers.

Trust signals on every page:

- A methodology link sits near every number.
- A source link sits on every data point.
- The corrections page link sits in the footer of every page. A public corrections page ships from day one. Source: campaign-guardrails (project skill).

---

## 7. Bot strategy

Split architecture. Reads open, writes locked.

Read paths, open to crawlers:

- All content pages are static HTML with stable URLs. Allow crawlers in robots.txt. Publish a sitemap. This serves SEO, citation, and researchers, and it is the whole point of a public evidence library.
- The pre-aggregated map JSON and library pages are public reads. No gate.

Write paths, locked:

- The story submission form and any action endpoint sit behind Cloudflare Turnstile. Turnstile is a privacy-first challenge that is free.
- Turnstile free tier, confirmed from the Cloudflare plans page: cost is Free, up to 20 widgets per account, unlimited challenges (traffic or verification requests), 10 hostnames per widget, and 7 days of analytics retention. Source: https://developers.cloudflare.com/turnstile/plans/ (fetched and confirmed 2026-07-20).
- Rate limit the Worker endpoints. Put Cloudflare rate limiting or WAF rules in front of any POST endpoint, and add a simple per-IP token bucket in the Worker backed by KV as a second layer. This protects the submission and any OG Worker from abuse.

COST FLAG: Turnstile is free at our scale. Worker requests and KV both have free tiers. Watch usage only if traffic spikes. Nothing here is expected to cost money.

---

## 8. Appendix. x402 machine-access concept

One-page sketch only. Not a build plan. This is a founder decision, not a recommendation.

The idea:

- Humans browse and cite for free. That never changes.
- Separately, offer one payment-gated endpoint in this project's own Cloudflare account that serves high-volume structured data to AI agents. An agent that wants bulk or programmatic access pays per request. A human reading and citing a page pays nothing.

What x402 is, from public docs:

- x402 is an open payment standard that uses the reserved HTTP 402 Payment Required status code to attach stablecoin micropayments to a web request. The flow is four steps: the client calls the endpoint, the server returns 402 with payment terms, the client signs a token transfer, and the client retries with the signed payload in a header. Source: https://www.x402.org/x402-whitepaper.pdf and https://x402.org/ (captured 2026-07-20).
- State of the spec in 2026: the Linux Foundation formalized an x402 Foundation on 2026-04-02 with a broad member list. It runs live on networks such as Base and Solana using USDC. It is described in the sources as the most-used agentic payment protocol in 2026. Source: https://www.allium.so/blog/x402-explained-the-internet-native-payments-standard-for-apis-data-and-agent-commerce/ (captured 2026-07-20).

Why it could fit here:

- It matches the OpenSecrets and GDELT precedent of free human access plus a separate machine-access path (section 1).
- It keeps citation, research, and public reading free, which the guardrails require, while charging only the automated bulk consumer.

Cautions and open questions:

- COST FLAG: any revenue path pulls in accounting, tax, and stablecoin custody questions. That is real overhead, not free.
- COST FLAG: taking payment changes the project's posture from pure advocacy to a service with paying customers. That is a positioning decision, not a technical one.
- The spec is young. Pin to the foundation's published spec version before any build, and treat every claim above as current-state, not settled.

UNVERIFIED: the x402 adoption figures and foundation date come from secondary sources and a search summary, not a primary filing. Confirm against the x402.org spec and the Linux Foundation announcement before acting.

---

## Sources consulted (all captured 2026-07-20)

- https://www.propublica.org/nerds/introducing-landline-and-stateline-two-tools-for-quick-vector-maps-in-your-
- https://www.propublica.org/nerds/mapping-state-millions
- https://github.com/nytimes/presidential-precinct-map-2024
- https://github.com/nytimes/presidential-precinct-map-2024/blob/main/README.md
- https://www.consumerfinance.gov/data-research/consumer-complaints/search/
- https://cfpb.github.io/api/ccdb/
- https://www.fcc.gov/consumer-complaints-center-data
- https://opendata.fcc.gov/Consumer/CGB-Consumer-Complaints-Data/3xyp-aqkj
- https://www.opensecrets.org/open-data
- https://usafacts.org/visualizations/
- https://www.gdeltproject.org/
- https://github.com/maplibre/maplibre-gl-js
- https://www.npmjs.com/package/maplibre-gl
- https://github.com/visgl/deck.gl
- https://www.npmjs.com/package/deck.gl
- https://docs.astro.build/en/concepts/islands/
- https://astro.build/
- https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/
- https://docs.astro.build/en/guides/deploy/cloudflare/
- https://pagefind.app/
- https://github.com/Pagefind/pagefind
- https://github.com/kvnang/workers-og
- https://developers.cloudflare.com/pages/functions/plugins/vercel-og/
- https://colorblind.io/guides/data-visualization
- https://developers.cloudflare.com/turnstile/plans/ (directly fetched and confirmed)
- https://www.x402.org/x402-whitepaper.pdf
- https://x402.org/
- https://www.allium.so/blog/x402-explained-the-internet-native-payments-standard-for-apis-data-and-agent-commerce/
