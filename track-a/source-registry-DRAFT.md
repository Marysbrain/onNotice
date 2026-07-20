# Source Registry (DRAFT) - Track A

Carriers On Notice. Verified source registry for the "on us" 36 month bill credit pattern.

All facts below come from pages fetched during verification. Capture date for everything: 2026-07-20.
Only sources marked GO or GO WITH LIMITS may be collected from. NO GO sources are logged and closed.

## Summary table

| # | Source | Verdict | One line reason |
|---|--------|---------|-----------------|
| 1 | FCC consumer complaint dataset (opendata.fcc.gov) | GO WITH LIMITS | Clean public domain API, but no carrier name field. Category level only. |
| 2 | FCC ECFS dockets and API | GO | Free key, open filings API, good for rulemaking and comment mining. |
| 3 | FTC cases, press releases, data | GO | Public domain content, RSS feeds and a legal library of cases. No case JSON API. |
| 4 | CFPB consumer complaint API | NO GO | Scope is financial products. Wireless service and device billing is out of jurisdiction. |
| 5 | CourtListener and RECAP | GO WITH LIMITS | Best litigation tracker, but tight rate limits and a no-derivatives license. |
| 6 | State AG press releases and settlements | GO WITH LIMITS | No single API. Mix of per-state feeds and two settlement databases. |
| 7 | BBB complaint pages | NO GO | ToS is personal non-commercial only. Robots blocks complaint pages. |
| 8 | Reddit Data API | GO WITH LIMITS (PROVISIONAL) | Terms look restrictive, but the primary policy pages would not load. Verdict pending a primary read. |
| 9 | News (GDELT, RSS, Google News RSS) | GO WITH LIMITS | Free for discovery and links. No full article republication. |

---

### 1. FCC consumer complaint public dataset

- Verdict: GO WITH LIMITS. The data is clean and public domain, but there is no carrier or company name field. You can find "Phone / Wireless / billing" complaints. You cannot tie a complaint to AT&T, Verizon, or T-Mobile.
- Access method: Socrata SODA API. Main dataset "CGB - Consumer Complaints Data", id 3xyp-aqkj. JSON endpoint: https://opendata.fcc.gov/resource/3xyp-aqkj.json . Supports CSV, JSON, XML and bulk export. SoQL query params work, for example ?issue_type=Phone&$limit=1000.
- Auth: None for reads. A free Socrata app token is optional and raises the throttle. Recommended for bulk pulls.
- Available fields: id (Ticket ID), ticket_created, date_created, issue_date, issue_time, issue_type (this is the Form, values are Phone, Internet, TV, Radio, Emergency, Accessibility, Broadband Story, Request for Dispute Assistance), method (for example "Wireless (cell phone/other mobile device)", wireline, etc), issue (the specific issue text, for example "Number Portability", billing), caller_id_number (unwanted calls only), type_of_call_or_messge, advertiser_business_phone_number (unwanted calls only), city, state, zip, location_1 (lat/long of the zip centroid). No company or carrier name field. No consumer narrative text field.
- Location granularity: city, state, and zip. Plus a zip centroid lat/long.
- License and usage terms: Public Domain, U.S. Government. Terms link in the dataset metadata: https://www.usa.gov/government-works . Free to reuse and republish.
- Rate limits: Not documented as hard numbers for the open endpoint. Socrata throttles anonymous traffic and lifts the throttle with a free app token. Treat as "use a token for bulk."
- Update frequency: Nightly. FCC states the complaint data generally updates nightly.
- Verified:
  - https://opendata.fcc.gov/api/views/3xyp-aqkj.json (metadata, columns, license) captured 2026-07-20
  - https://opendata.fcc.gov/resource/3xyp-aqkj.json (live field values and Form counts) captured 2026-07-20
  - https://api.us.socrata.com/api/catalog/v1?domains=opendata.fcc.gov&q=consumer+complaints (dataset list) captured 2026-07-20
- Notes: Row count for the Phone form is about 2.58 million. This dataset is the general informal complaint feed since Oct 31 2014. It is not the same as the aggregated category counts datasets. Related aggregate datasets exist if you want pre-rolled counts: "CGB - Consumer Complaints by Category Current YTD" (kvap-rzqf) and "Consumer Complaints - Most Common Issues" (845q-3wwu). The big limit for this project stands: you get category, method, issue, and location, but never the carrier name. Use it for baseline "wireless billing complaint" volume and geography, not for per-carrier counts.

---

### 2. FCC ECFS (Electronic Comment Filing System) dockets and API

- Verdict: GO. Open filings API with a free key. Good for tracking rulemaking dockets and mining public comments about carrier billing and bill credit practices.
- Access method: REST API. Base endpoint confirmed live: https://publicapi.fcc.gov/ecfs/filings . Example that returned data: https://publicapi.fcc.gov/ecfs/filings?api_key=DEMO_KEY&limit=1 . Query by proceedings (docket number), filer, date, and full text.
- Auth: Free API key from api.data.gov. Register through the ECFS help page. DEMO_KEY works for testing but is heavily throttled.
- Available fields: A filing record returned these keys live: id_submission, submissiontype, proceedings (docket), filers, authors, lawfirms, bureaus, date_received, date_submission, date_disseminated, date_last_modified, text_data (the comment text), documents, attachments, total_page_count, express_comment, exparte_or_late_filed, filingstatus, viewingstatus. So date yes, filer name yes, docket yes, and narrative comment text yes.
- Location granularity: None reliable. Filings carry filer names and sometimes an address, not a clean state or zip column. Treat location as absent for mapping.
- License and usage terms: Public Domain, U.S. Government work. FCC filings are public record. Free to reuse.
- Rate limits: The DEMO_KEY response carried header x-ratelimit-limit: 10. A real api.data.gov key uses the standard api.data.gov default, which is confirmed primary as 1,000 requests per hour per key. Source: api.data.gov developer manual, "Hourly Limit: 1,000 requests per hour." Confirm your key's limit in the api.data.gov signup, since it is the authority on your quota.
- Update frequency: Real time to near real time. Filings appear as they are accepted.
- Verified:
  - https://publicapi.fcc.gov/ecfs/filings?api_key=DEMO_KEY&limit=1 (live record, field list, and x-ratelimit-limit header) captured 2026-07-20
  - https://api.data.gov/docs/developer-manual/ (default 1,000 requests per hour per key, DEMO_KEY usage) captured 2026-07-20
- Notes: The free key requirement is confirmed live, since the API rejects calls without api_key and DEMO_KEY works. The ECFS help page at https://www.fcc.gov/ecfs/help/public_api and the doc page at https://www.fcc.gov/ecfs/public-api-docs.html are JavaScript rendered single page apps. Both returned empty to curl and timed out or errored in the fetch tool, so neither could be read directly. The exact registration URL is therefore UNVERIFIED, but api.data.gov is the standard FCC key issuer. The parameter and field list is confirmed from the live JSON response, not from the doc page. text_data plus documents means you can pull the actual comment language for keyword scans like "36 month" or "bill credit." Use proceedings to lock onto a specific docket. Paginate with limit and offset.

---

### 3. FTC cases, press releases, and public data

- Verdict: GO. All FTC content is federal public domain. Strong for enforcement signal and citations. There is no clean JSON case API, so you monitor RSS and the legal library.
- Access method: Working press release RSS feed confirmed live: https://www.ftc.gov/feeds/press-release.xml . A consumer protection only feed is also live: https://www.ftc.gov/feeds/press-release-consumer-protection.xml . A competition feed exists at https://www.ftc.gov/feeds/press-release-competition.xml . The feed index page is https://www.ftc.gov/news-events/stay-connected/ftc-rss-feeds . Press releases in HTML at https://www.ftc.gov/news-events/news/press-releases . Legal Library cases and proceedings at https://www.ftc.gov/legal-library/browse/cases-proceedings with a search at https://www.ftc.gov/legal-library/search .
- Auth: None.
- Available fields: For press releases and legal library items you get title, date, body text, case or matter name, and often the docket or file number and company name in the text. This is document level, not a structured complaint table. No per-consumer state or zip.
- Location granularity: None.
- License and usage terms: Public domain, U.S. Government work. Free to reuse and republish.
- Rate limits: Not documented. Poll RSS politely, for example every few hours.
- Update frequency: RSS updates as releases post. Same day.
- Verified:
  - https://www.ftc.gov/feeds/press-release.xml (live, valid RSS, 10 items, first title read) captured 2026-07-20
  - https://www.ftc.gov/feeds/press-release-consumer-protection.xml (live, valid RSS, 30 items) captured 2026-07-20
  - https://www.ftc.gov/news-events/stay-connected/ftc-rss-feeds (feed index, live, feed URLs read directly from the page) captured 2026-07-20
- Notes: The GO verdict now rests on two live feeds, not on a snippet. The developer page at https://www.ftc.gov/developer returned 403 to the fetch tool on two tries and could not be read. So any "high value datasets" or FTC API claim is UNVERIFIED and must not be relied on. A collector must read that page directly before assuming a dataset API exists. The legal library cases page was not fetched in this pass, so treat it as a known HTML source to confirm at build time, not as verified. The reliable path is the confirmed RSS feeds plus the legal library search filtered to telecom and mobile matters. Store title, url, date, and the docket or file number, and archive each page to Wayback at capture.

---

### 4. CFPB consumer complaint database public API

- Verdict: NO GO for this project's core purpose. The CFPB database is scoped to consumer financial products. Wireless service billing and carrier device promotions are not CFPB jurisdiction. They sit with the FCC and the FTC. So the database will not give you a carrier device-promo complaint feed.
- Access method: CCDB5 search API base https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/ . Output in json, csv, xls, xlsx. Docs at https://cfpb.github.io/api/ccdb/ and https://cfpb.github.io/ccdb5-api/ .
- Auth: None documented for read access.
- Available fields: Date received, Product, Sub-product, Issue, Sub-issue, Consumer complaint narrative (only when the consumer consents), Company public response, Company, State, ZIP code, Tags, Submitted via, Date sent to company, Company response to consumer, Timely response, Complaint ID. So it does have company name, state, zip, and narrative. The problem is scope, not fields.
- Location granularity: state and zip. Zip is masked in low population areas for privacy.
- License and usage terms: CFPB is a U.S. Government body and its released material is public domain by default in the United States (stated on cfpb.github.io). Free to reuse.
- Rate limits: Not documented as hard numbers on the pages read.
- Update frequency: Daily.
- Verified:
  - https://cfpb.github.io/api/ccdb/fields.html (full field list) captured 2026-07-20
  - https://cfpb.github.io/api/ccdb/ (direct fetch, states the scope is "consumer financial products and services," updates daily, public domain) captured 2026-07-20
- Notes: One open question could not be verified live. Carriers can appear inside the CFPB data indirectly when an unpaid device balance goes to a collector or hits a credit report, which would show up under "Debt collection" or "Credit reporting" with the carrier or collector as the company. I tried to confirm this by querying the live search API for Verizon, AT&T, and T-Mobile. The API host refused the connection from the sandbox and later returned 503 and timeouts. So the indirect-appearance question is UNVERIFIED. Even if confirmed later, it would be a debt and credit signal, not a bill credit promo signal, so the NO GO verdict for our core use stands. If Track wants the debt angle later, re-open and verify the live query.

---

### 5. CourtListener and RECAP (Free Law Project)

- Verdict: GO WITH LIMITS. This is the right tool for litigation tracking. Two limits matter: the default API rate is now very tight, and the reuse license on Free Law Project content is no-derivatives.
- Access method: REST API v4 base https://www.courtlistener.com/api/rest/v4/ . Endpoints for opinions and case law clusters, dockets, RECAP PACER data, search, judges, and citation lookup. Bulk data files on AWS S3, described at https://www.courtlistener.com/help/api/bulk-data/ .
- Auth: Token auth. Header is Authorization: Token YOUR_KEY. V4 rejects anonymous requests to many endpoints with 401.
- Available fields: Docket number, court, party names, case name, date filed, filings and entries, documents, plus opinion text for case law. RECAP holds dockets, entries, documents, parties, and attorneys.
- Location granularity: court and jurisdiction, not consumer location.
- License and usage terms: Free Law Project content is licensed Creative Commons BY-ND 4.0 except where noted, per free.law. BY-ND means you may share with attribution but not publish modified or derivative versions of their compiled content. Underlying court opinions and dockets are public record facts. Read the license before republishing any compiled text: https://free.law/datasets/ . The code is AGPL, which does not bind our data reuse.
- Rate limits: The wiki overview, fetched live, gives current authenticated defaults of 5 requests per minute, 50 per hour, and 125 per day, on a rolling window. The free.law blog dated 2026-05-07, fetched directly, explains the change. In its own words, before that date "we gave every CourtListener user 5,000 API requests per hour out of the box," and "Starting today, the default rate is lower to protect our infrastructure." Grandfathering, direct quote: "If you've ever made 1,000 or more API requests, you're grandfathered in. Your existing rate stays in place." Membership tiers raise the limit. So the two pages agree: 5,000 per hour was the old default, and the low 5/50/125 numbers are the new post May 2026 default.
- Update frequency: API is live. Bulk files, per the bulk data page fetched directly, are regenerated quarterly on the last day of March, June, September, and December beginning at 3AM PST, and streamed to an AWS S3 bucket.
- Verified:
  - https://wiki.free.law/c/courtlistener/help/api/rest/v4/overview (base url, auth, current 5/50/125 rate limits) captured 2026-07-20
  - https://free.law/2026/05/07/api-included-in-memberships/ (direct fetch, old 5,000/hr default, May 2026 lowering, 1,000-request grandfather, membership tiers) captured 2026-07-20
  - https://www.courtlistener.com/help/api/bulk-data/ (direct fetch via curl, quarterly regeneration, AWS S3, data types include case law, embeddings, oral arguments, dockets, judges) captured 2026-07-20
  - https://free.law/datasets/ (direct fetch, footer confirms "Content licensed under a Creative Commons BY-ND international 4.0 license, except where indicated") captured 2026-07-20
- Notes: At 125 requests per day the live API alone will not sustain broad monitoring. Plan for a Free Law Project membership or use the quarterly bulk dumps for backfill and the API only for targeted lookups and alerts. CourtListener also has a saved-search alert feature that can watch for new filings that match carrier and bill credit terms. The BY-ND license means quote and link, do not repackage their text as your own dataset.

---

### 6. State attorney general press releases and multistate settlements

- Verdict: GO WITH LIMITS. There is no single clean API across all states. You run a hybrid: two settlement databases for multistate actions, plus per-state feeds for the big states.
- Access method: The confirmed anchor is the per-state feed. California has a working RSS feed, fetched live and valid: https://oag.ca.gov/news/feed . Build on that first. Texas offers email release notifications at https://www.texasattorneygeneral.gov/news/releases . New York lists releases at https://ag.ny.gov/press-releases . Two aggregator databases exist but could not be verified this pass, see below: the NAAG Multistate Settlements Database at https://www.naag.org/news-resources/research-data/multistate-settlements-database/multistate-data-collection-methods/ , and the attorneysgeneral.org State Litigation and AG Activity Database at https://attorneysgeneral.org/settlements-and-enforcement-actions/ .
- Auth: None.
- Available fields: Press release title, date, body text, and named companies. The settlement databases add settlement amount, participating states, and links to final documents. No consumer level location.
- Location granularity: state, at the level of "which AG or which states joined." Not consumer location.
- License and usage terms: State government press releases are generally public record. Reuse of the fact of a settlement and short quotes is safe. The two aggregator databases are third party. Confirm each aggregator's own terms before bulk copying their compiled tables. Facts and links are fine to cite.
- Rate limits: Not documented. Poll RSS and pages politely.
- Update frequency: Press releases post same day. The NAAG and attorneysgeneral.org databases update on their own cadence, not real time.
- Verified:
  - https://oag.ca.gov/news/feed (live RSS, 10 items, valid XML, first item title read) captured 2026-07-20
  - https://www.naag.org/news-resources/research-data/multistate-settlements-database/multistate-data-collection-methods/ (direct fetch attempted, returned HTTP 403, could not read) captured 2026-07-20
  - https://attorneysgeneral.org/settlements-and-enforcement-actions/ (direct fetch attempted, returned HTTP 406, could not read) captured 2026-07-20
- Notes: Only the California RSS feed is verified as live XML. Both aggregator databases are UNVERIFIED. NAAG returned 403 and attorneysgeneral.org returned 406 to a direct fetch, so their contents, field structure, and terms are unconfirmed. Do not build on either until a collector confirms them, likely through a browser session rather than a plain fetch. Texas and New York have press release pages but their feed or subscription format was not fetched and tested, so treat TX and NY ingestion as needing a format check before build. For a first build, anchor on the confirmed CA RSS feed and add sources as they are verified. Archive each cited release to Wayback at capture.

---

### 7. BBB public complaint pages

- Verdict: NO GO. Clean collection is not permitted. The BBB Terms of Use restrict content to personal, non-commercial use, and robots.txt blocks the complaint pages.
- Access method: Not usable within terms. Business profiles sit under /us/.../profile/... . Complaint intake is under /file-a-complaint/ .
- Auth: n/a.
- Available fields: n/a. Not collecting.
- Location granularity: n/a.
- License and usage terms: BBB Terms of Use state you may "only use and access, download and copy the BBB Content for your personal, non-commercial use," and you may not remove their notices. A public advocacy platform that republishes is not personal non-commercial use. robots.txt disallows /file-a-complaint/* and disallows all query string URLs with Disallow: /*? . It allows profile pages but not the complaint intake paths.
- Rate limits: n/a.
- Update frequency: n/a.
- Verified:
  - https://www.bbb.org/robots.txt (Disallow /file-a-complaint/* and Disallow /*?) captured 2026-07-20
  - https://www.bbb.org/terms-of-use (personal non-commercial use clause) captured 2026-07-20
- Notes: You can still read a BBB page as a human and cite a single specific complaint as one referenced example with a link, the way you would cite any web page. What you cannot do is scrape or bulk ingest BBB complaint content into the registry. Keep BBB out of the automated pipeline.

---

### 8. Reddit public API for carrier subreddits

- Verdict: GO WITH LIMITS, PROVISIONAL. The limits look heavy, but this verdict is provisional pending a primary read of Reddit's own policy pages. Both primary pages failed to load in this pass, so the specific terms below are UNVERIFIED. Do not act on Reddit until a collector confirms them directly. If Reddit will not approve a non-commercial use case for this platform, it becomes NO GO.
- Access method: Reddit Data API over OAuth. Data API wiki: https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki . Data API Terms: https://www.redditinc.com/policies/data-api-terms .
- Auth: OAuth client. UNVERIFIED claim: as of a November 2025 Responsible Builder Policy the free tier also requires pre-approval of your use case, with review of roughly 2 to 4 weeks. This could not be confirmed from a primary page and must be checked before relying on it.
- Available fields: Post and comment text, author handle, subreddit, score, timestamps, permalinks. No reliable user location.
- Location granularity: none.
- License and usage terms: UNVERIFIED. The following are believed true from secondary coverage but were not confirmed on a primary page in this pass. (a) The free tier prohibits commercial use, and commercial use, including brand monitoring or powering a product feature, requires a separate paid agreement. (b) Retaining content that a user later deletes, even if de-identified, violates Reddit policy, so you must honor deletions. (d) The reported commercial rate is about 0.24 dollars per 1,000 calls. Each of (a), (b), and (d) is UNVERIFIED and needs a primary read.
- Rate limits: UNVERIFIED. (c) Free tier is reported as about 100 queries per minute per OAuth client, and about 10 per minute without OAuth. This is UNVERIFIED, since the wiki page that documents it would not load.
- Update frequency: Real time.
- Verified:
  - https://www.redditinc.com/policies/data-api-terms (direct fetch attempted, returned HTTP 301 to another host and would not resolve, could not read) captured 2026-07-20
  - https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki (direct fetch attempted, returned HTTP 403, could not read) captured 2026-07-20
- Notes: Nothing in this entry is primary-sourced. Both of Reddit's own pages, the Data API Terms and the Data API wiki, refused to load, one with a cross-host 301 and one with a 403. So the four load-bearing claims, tagged (a) through (d) above, are all UNVERIFIED. A collector must read those two pages in a browser session before Reddit is used. If confirmed, two hard risks remain for us. One, "commercial use" is Reddit's call, and a public advocacy platform could be read as commercial, which would force a paid contract. Two, the deletion rule means you need a delete-sync job that removes or re-checks stored posts, or you are out of compliance the moment a user deletes. If Track A wants Reddit, get the non-commercial approval in writing first, store only permalink plus captured excerpt plus timestamp, and build the deletion sync before any storage. Do not display user handles in public output. If any of that cannot be met, drop Reddit and log why.

---

### 9. News coverage (GDELT, RSS, Google News RSS)

- Verdict: GO WITH LIMITS. Free and clean for discovery, headlines, and links. Not licensed for republishing full articles. Store metadata and a link, not the article body.
- Access method:
  - GDELT 2.0 DOC API. Full text news search over a rolling three month window. JSON and JSONP output. Announcement and docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/ . Data hub: https://www.gdeltproject.org/data.html .
  - Google News RSS search. Confirmed working: https://news.google.com/rss/search?q=YOUR+QUERY&hl=en-US&gl=US&ceid=US:en . Returns title, link, publish date, and source name.
  - Consumer tech press RSS feeds, for example the outlet's own /rss or /feed endpoints.
- Auth: None for GDELT DOC and for Google News RSS.
- Available fields: For GDELT DOC artlist mode, the field list is UNVERIFIED in this pass. The live API returned its rate limit guard on every attempt from both fetch paths, so no successful article JSON was captured to read the exact keys. GDELT's own docs describe url, title, domain, language, and publish datetime, but treat the field names as needing one clean run to confirm. Google News RSS gives title, link, pubDate, and source, and this was confirmed live. Outlet RSS gives title, link, date, and usually a short summary.
- Location granularity: none for our purpose. GDELT has geographic tagging of story content, not consumer location.
- License and usage terms: GDELT states the database is 100 percent free and open. Google News RSS and outlet RSS deliver headlines and links, and the article text stays copyright the publisher. Store and display the headline, source, date, and link. Do not republish full article text. Short quotes with attribution only, in line with the campaign copyright rule.
- Rate limits: Confirmed primary from the live API. GDELT's own server returned this text on our calls: "Please limit requests to one every 5 seconds or contact [address] for larger queries. All high-traffic users should switch to our ngrams dataset." The fetch tool path returned HTTP 429 Too Many Requests. So one request per five seconds is the documented limit, straight from the endpoint. Google News RSS has no published number, so poll gently. Outlet RSS, poll on the feed's own cadence.
- Update frequency: GDELT updates continuously, DOC covers the last three months. Google News RSS and outlet RSS update as stories publish.
- Verified:
  - https://news.google.com/rss/search?q=AT%26T+bill+credit (direct fetch via curl, live, returned 74 items with title and source) captured 2026-07-20
  - https://api.gdeltproject.org/api/v2/doc/doc?query=%22bill+credits%22+wireless&mode=artlist&format=json&maxrecords=5 (direct live GET, endpoint is up and returned its own rate limit notice quoting "one every 5 seconds"; a clean article payload was blocked by that limit) captured 2026-07-20
- Notes: The GDELT endpoint is confirmed live and its rate limit is now primary-sourced from the server itself. What is NOT confirmed is the article field list, because every attempt hit the rate guard, so a collector must make one clean spaced call to lock the exact keys. GDELT DOC only reaches back three months, so it is a live radar, not an archive. For backfill and for a rate-limit-free feed, GDELT Web NGrams 3.0 is a downloadable minute-level dataset. Use GDELT and Google News RSS to discover coverage, then archive each cited article to Wayback and keep a local snapshot at capture, as the archive rule requires.

---

## Additional promising sources found along the way (UNVERIFIED)

1. attorneysgeneral.org State Litigation and AG Activity Database. Searchable multistate settlements and enforcement actions from 1980 to present, with final documents. Strong backfill for the settlement leg. UNVERIFIED, a direct fetch returned HTTP 406, so it needs a browser session to confirm.
2. FCC aggregated category datasets on the same Socrata portal, for example "CGB - Consumer Complaints by Category Current YTD" (kvap-rzqf) and "Consumer Complaints - Most Common Issues" (845q-3wwu). Pre-rolled counts that could save compute if you only need trend lines. Seen in the live Socrata catalog listing, per-dataset contents UNVERIFIED.
3. GDELT Web NGrams 3.0. A downloadable, minute-updated unigram dataset across all monitored coverage. GDELT's own live rate limit notice pointed to it as the path for high-traffic users, so the pointer is primary, but the dataset structure itself is UNVERIFIED.

## Open items to close before build

- ECFS parameter list came from the live JSON response, not the doc page. Both ECFS doc pages, help/public_api and public-api-docs.html, are JavaScript single page apps that return empty to curl and error in the fetch tool. Read them in a browser once before building the collector, and confirm the exact registration URL for the free api.data.gov key.
- FTC "high value datasets" or any FTC dataset API claim is UNVERIFIED. https://www.ftc.gov/developer returned 403 to the fetch tool on two tries. The GO verdict stands on the two live RSS feeds, not on any dataset API.
- FTC legal library cases page was not fetched this pass. Confirm at build time.
- CFPB indirect carrier appearance under debt and credit categories is UNVERIFIED because the live search API refused connections. The core NO GO stands on the confirmed scope, "consumer financial products and services." Only re-open if Track wants the debt angle.
- CourtListener rate story is now primary. Current default is 5/50/125, the old 5,000 per hour default was lowered on 2026-05-07, and 1,000-plus-request accounts are grandfathered. No open item.
- GDELT article field names are UNVERIFIED. The endpoint and its one-per-5-second rate limit are primary, but the rate guard blocked a clean payload. Make one spaced call to lock the field names.
- NAAG returned 403 and attorneysgeneral.org returned 406 to direct fetch. Both settlement databases are UNVERIFIED. Confirm in a browser session before use. Source 6 leans on the confirmed CA RSS in the meantime.
- Texas and New York AG feed formats were not fetched and tested. Confirm feed or subscription format before wiring them in.
- Reddit is fully UNVERIFIED. Both Reddit policy pages, data-api-terms and the Data API wiki, would not load, 301 and 403. Read both in a browser before any Reddit use.
