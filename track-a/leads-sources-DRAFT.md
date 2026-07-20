# Track A: Leads-Tier Source Registry (DRAFT)

Capture date for every fetch below: 2026-07-20. All verdicts are leads-tier calls unless marked otherwise. A search-result snippet was never treated as proof. Where a page would not load, the dependent claims are marked UNVERIFIED inline.

## Summary table

| # | Source | Tier call | One line reason |
|---|--------|-----------|-----------------|
| 1 | AAA + JAMS consumer arbitration data | EVIDENCE (company-named) | Quarterly Excel, names the respondent company, mandated by CA CCP 1281.96 |
| 2 | SEC EDGAR full text search + APIs | EVIDENCE | Public JSON API, carrier filings searchable, clear UA and rate rules |
| 3 | Wayback CDX + Save Page Now | EVIDENCE (as our tooling) | Public capture history plus our archive-at-capture engine |
| 4 | FCC FOIA for carrier-named complaints | LEADS | Process is real, but a release is a request not a dataset; slow and uncertain |
| 5 | Class action / plaintiff firm monitoring | LEADS (via CourtListener) | Aggregators block automation; CourtListener alerts are the clean path |
| 6 | Carrier community forums | NO GO for scraping | AT&T forum is dead; Verizon and T-Mobile allow only hand-reading |
| 7 | State PUC complaint data (CA, NY, TX) | LEADS (CA only) | Only CA CPUC names carriers; NY and TX send wireless elsewhere |
| 8 | Google Custom Search JSON API | NO GO | Closed to new customers, full shutdown Jan 1 2027 |
| 9 | Reddit RSS feeds | NO GO | Throttled to about 1 request per minute; User Agreement bars automated collection |

---

### 1. AAA and JAMS consumer arbitration case data
- Tier call: EVIDENCE. This is the strongest source in the set. The file names the company by law.
- Access method:
  - AAA: https://www.adr.org/ConsumerArbitrationStatistics (the download is labeled the "Consumer Case-filing Spreadsheet").
  - JAMS: https://www.jamsadr.com/consumercases
- Auth: none. Public download.
- Available fields:
  - AAA: 30-plus fields per the report legend. Confirmed present: Case ID, disposition, case type, and the non-consumer (business) party. Company name YES. A case against two businesses gets two rows sharing one Case ID.
  - JAMS: the page states the report gives "the name of the non-consumer party, the result of the consumer arbitration and the JAMS usage history by the non-consumer party." Company name YES.
- Location granularity: not a mapping source. This is case-level litigation data, not geographic. State of the arbitration may appear. No consumer-level personal profiling should be built from it.
- License and usage terms: neither page posts an explicit reuse license. The data is published because CA CCP 1281.96 compels quarterly public posting. Treat as public record. No terms of reuse were found on the JAMS page footer during this fetch. UNVERIFIED whether AAA attaches any reuse restriction; confirm before republishing raw rows. Terms pages read: none available on the two data pages themselves.
- Rate limits: none. It is a single file download, not an API.
- Update frequency: quarterly for both, as required by statute. AAA current file described in secondary coverage as Q4 2024 with about 194,983 rows. That row count is UNVERIFIED against the live file (not opened during this task).
- Verified (fetched 2026-07-20):
  - https://www.jamsadr.com/consumercases (fetched, confirmed Excel, quarterly, names non-consumer party)
  - http://www.adr.org/ConsumerArbitrationStatistics (fetched, confirmed a quarterly "Consumer Case-filing Spreadsheet" made available pursuant to state statutes)
  - https://www.adr.org/industries/consumer/ (fetched, confirmed the statistics report exists and updates quarterly "as required by law")
- Notes: To use this as EVIDENCE, download the actual xlsx and confirm the exact respondent column header before publishing any AT&T Mobility count. The AAA page rendered without exposing the raw file link on the fetched version, so a builder must click through the live page to grab the current file URL. Filter to respondent = AT&T Mobility (and its variants). This is the one source here that can back a public number on its own.

---

### 2. SEC EDGAR full text search and main APIs
- Tier call: EVIDENCE. Primary-source corporate disclosure, public and free.
- Access method:
  - Full text search: https://efts.sec.gov/LATEST/search-index?q=...
  - Structured data: https://data.sec.gov/ (submissions, company facts, company concept)
- Auth: none, but a descriptive User-Agent header is required.
- Available fields: full filing text plus metadata (form type, filing date, accession number, CIK). Carrier filings are searchable. Company name YES. Query by keyword and filter by form and date. There is no ticker parameter on the full text endpoint, so search by entity name or keyword, or resolve the CIK first for T, VZ, and TMUS.
- Location granularity: not applicable. Corporate filings, not consumer geography.
- License and usage terms: US government work, public domain. Governed by the SEC fair access policy.
- Rate limits: 10 requests per second across all EDGAR APIs. Exceeding it triggers a temporary IP block. Required User-Agent format is "CompanyName email@example.com".
- Update frequency: continuous as filers submit. Full text index covers filings from 2001 forward.
- Verified (fetched 2026-07-20):
  - https://tldrfiling.com/blog/sec-edgar-full-text-search-api (fetched; confirms endpoint, JSON response, q/forms/dateRange/from/size params, 10 req/s, UA rule)
- Notes: SEC's own pages (sec.gov, efts.sec.gov) returned 403 to our fetch tool during this task. That is our fetcher's User-Agent being rejected by the SEC edge, not the API being down. A real collector that sets the required UA header will work. Do not rely on WebFetch for SEC; use a proper client with the UA header. The endpoint and rules above were verified from a fetched third-party technical page, not from sec.gov directly, so re-confirm the UA string against SEC's own doc from a compliant client before ingest.

---

### 3. Wayback Machine CDX API and Save Page Now
- Tier call: EVIDENCE, as our own tooling. This is how we reconstruct carrier promo pages and satisfy the archive-at-capture rule.
- Access method:
  - CDX Server: http://web.archive.org/cdx/search/cdx
  - Availability JSON: http://archive.org/wayback/available?url=...
  - Save Page Now: https://web.archive.org/save/
- Auth:
  - CDX and Availability: none.
  - Save Page Now: S3-style keys strongly preferred, header "authorization: LOW accesskey:secret", keys from https://archive.org/account/s3.php. UNVERIFIED against a primary Internet Archive page; the SPN2 auth and limit details below came from search plus a referenced archive.org doc, not a clean primary fetch this session.
- Available fields (CDX): urlkey, timestamp, original url, mimetype, statuscode, digest, length. Customizable with fl=. JSON output with output=json.
- Location granularity: not applicable.
- License and usage terms: no explicit reuse terms in the CDX README. Internet Archive general terms apply. Treat captures as citation sources with the snapshot URL and timestamp.
- Rate limits:
  - CDX: none documented in the README. Be polite; throttle and cache.
  - Save Page Now: reported about 15 requests per minute and up to 7 concurrent save sessions per user. UNVERIFIED against a primary page this session.
- Update frequency: on demand. CDX reflects whatever has been captured. Save Page Now captures live on request.
- Verified (fetched 2026-07-20):
  - https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md (fetched; endpoint, params, JSON output, gzip default)
  - https://archive.org/help/wayback_api.php (fetched; Availability API, CDX and Memento referenced)
- Notes: Use CDX with matchType=prefix or domain to pull a carrier promo path history, collapse=digest to drop unchanged duplicates, and from/to to bound dates. For our archive rule, wire Save Page Now with S3 keys and record the returned snapshot URL next to every cited page. Confirm the live SPN2 rate limit from your authenticated account before running a bulk archive job.

---

### 4. FCC FOIA channel for carrier-named informal complaint data
- Tier call: LEADS. The process is real. It is a request path, not a standing dataset, so it cannot feed a public count until a specific release lands and is verified.
- Access method:
  - FCC FOIA home: https://www.fcc.gov/foia
  - Filing portal: FCC ArkCase FOIA system (reached from the FOIA home page). UNVERIFIED via primary fetch; fcc.gov/foia and the how-to-file page both timed out during this task, so the ArkCase detail is from search only.
  - Electronic Reading Room: https://www.fcc.gov/general/freedom-information-act-electronic-reading-room. UNVERIFIED; this page timed out on fetch.
  - Why FOIA at all, verified: the public FCC complaint dataset does NOT name the company. See below.
- Auth: none to file. You submit a request and pay any fees over the threshold.
- Available fields: whatever a specific release contains. Not predefined. A prior release of carrier-named complaint records would live in the reading room or arrive directly to the requester.
- Location granularity: unknown until a release exists.
- License and usage terms: released FOIA records are public. UNVERIFIED wording, reading room page did not load.
- Rate limits: not applicable. Human process.
- Update frequency: not applicable. Per request. FCC guidance notes the search fee threshold is around 25 dollars before they notify you.
- Verified (fetched 2026-07-20):
  - https://opendata.fcc.gov/api/views/3xyp-aqkj/columns.json (fetched; full column list confirms there is NO carrier or company name column, and that "Method" carries the service type including Wireless)
  - Supporting, search only, primary fetch UNVERIFIED: FCC FOIA home and reading room pages timed out twice.
- Notes: This is the key structural finding for the whole FCC angle. The public CGB Consumer Complaints dataset covers wireless but strips the company name. So you cannot attribute a public FCC complaint to AT&T from the open data alone. That is exactly the gap a FOIA request would try to fill. Treat FOIA as a slow investigation lead. Do not promise it will produce carrier-named data; agencies often withhold or aggregate. Re-verify the ArkCase portal and reading room from a browser, since our fetcher could not load fcc.gov this session.

---

### 5. Class action and plaintiff firm investigation announcements
- Tier call: LEADS. Best served through CourtListener, not through news aggregators.
- Access method:
  - Recommended clean path: CourtListener REST API v4 and Search Alerts. https://www.courtlistener.com/api/rest/v4/ and https://www.courtlistener.com/help/api/rest/
  - Aggregators to read by hand only: https://www.classaction.org/ and Top Class Actions.
- Auth:
  - CourtListener: free API token for programmatic use. Alerts require a free account.
  - ClassAction.org: no automated access permitted, see terms below.
- Available fields:
  - CourtListener: dockets, docket entries, documents, parties, attorneys, and full text search across case law and the RECAP PACER archive. Covers federal district courts, where carrier class actions are filed. Company name YES.
- Location granularity: court and jurisdiction level. Not consumer geography.
- License and usage terms:
  - CourtListener: open source project, data is public court records. Terms: https://www.courtlistener.com/help/api/rest/ (v4 overview fetched).
  - ClassAction.org: terms at https://www.classaction.org/terms-of-use prohibit automated access. Quoted from the fetched page: crawling or spidering the site is "strictly prohibited," and users may not monitor, copy, or data mine the content beyond personal use. So automated collection is a NO GO for that site. Reading a single announcement and hand-citing it with a link is fine.
- Rate limits:
  - CourtListener: 5 requests per minute, 50 per hour, 125 per day for authenticated users. Higher limits by membership.
- Update frequency: CourtListener updates continuously as PACER and court data flow in. RECAP holds close to half a billion PACER items.
- Verified (fetched 2026-07-20):
  - https://wiki.free.law/c/courtlistener/help/api/rest/v4/overview (fetched; API v4, RECAP, dockets, token auth, rate limits)
  - https://www.classaction.org/terms-of-use (fetched; explicit ban on crawling, scraping, and data mining)
- Notes: Recommendation: build a CourtListener Search Alert for carrier names plus the promo terms, and pull matching dockets through the v4 API with a token. That gives you the actual filed complaints, which are citable primary records, instead of a law firm marketing blog. Use aggregators only as a human tip sheet. Their low daily rate limit means you batch queries and cache. A ClassAction.org RSS blog feed may exist, but their terms bar automated consumption, so do not poll it.

---

### 6. Carrier community forums
- Tier call: NO GO for scraping across all three. Hand-reading and citing a single thread with its link stays viable for Verizon and T-Mobile. AT&T's forum is gone.
- Access method:
  - AT&T: forums.att.com now 301 redirects to a sunset notice at https://www.att.com/support/how-to/community-forums-sunset. The forum was shut down June 27, 2024.
  - Verizon: https://community.verizon.com (robots.txt fetched).
  - T-Mobile: https://www.t-mobile.com/community (community.t-mobile.com 301 redirects here; robots.txt fetched).
- Auth: none to read public threads.
- Available fields: thread title, post text, timestamps, public usernames. Do not collect usernames. Per campaign rules, aim at practices, never at individuals.
- Location granularity: none reliable.
- License and usage terms: each site's ToS plus robots.txt. Automated scraping is not permitted. Reading a page a human could read and citing it is the allowed path.
- Rate limits: not applicable for hand-reading.
- Update frequency: live for Verizon and T-Mobile. AT&T is frozen and redirecting.
- Verified (fetched 2026-07-20):
  - https://community.verizon.com/robots.txt (fetched; User-agent: *, disallows /search/, /messages/, /profile/discussions/, /categories/*/p, /sso, and others)
  - https://www.t-mobile.com/community/robots.txt (fetched; User-agent: *, disallows /community/users/, /community/mysettings/, /community/help, closed group hub, media gallery; no blanket ban on public thread URLs)
  - forums.att.com/robots.txt (fetched; returned a 301 redirect to the AT&T community-forums-sunset support page, confirming the forum is retired)
- Notes: Verizon robots blocks the search and paginated category paths, which kills any crawl of the discussion index even though individual threads may render. T-Mobile robots blocks account and settings paths but not every public thread, still, the ToS governs and scraping is out. Practical rule for the team: when a forum thread shows the 36 month bill credit pattern, open it in a browser, quote a short excerpt, save the URL, and run Save Page Now. One thread, one citation, by hand. No crawler. For AT&T, pull historical threads from the Wayback CDX instead, since the live forum is dead.

---

### 7. State public utility commission complaint data (CA, NY, TX)
- Tier call: LEADS, and only for California. NY and TX are NO GO for wireless.
- Access method:
  - CA CPUC: https://www.cpuc.ca.gov/about-cpuc/divisions/news-and-public-information-office/consumer-affairs-branch/consumer-complaints-and-inquiries-statistics
  - NY PSC / DPS: https://dps.ny.gov/file-complaint
  - TX PUC: https://www.puc.texas.gov/consumer-help/telecommunications/
- Auth: none.
- Available fields:
  - CA CPUC: informal contacts and informal complaints for the communications, energy, and water industries. The fetched page states the communications tables are presented "by Company," so individual carriers are named. Company name YES for CA. Format is monthly PDF reports, not a clean dataset.
  - NY: no usable wireless dataset. DPS directs cellular complaints to the NY Attorney General, so wireless sits largely outside PSC jurisdiction.
  - TX: no usable wireless dataset. PUCT states it does not regulate wireless or cellular service and refers those complaints to the FCC.
- Location granularity: California data is statewide, broken out by industry and company, not by consumer ZIP.
- License and usage terms: California public agency records. No explicit reuse license found on the statistics page. Treat as public record.
- Rate limits: not applicable. PDF downloads.
- Update frequency: CA CPUC page presents monthly reporting, but the most recent data visible on the fetched page was 2019, so the public posting looks stale. Current-year availability is UNVERIFIED.
- Verified (fetched 2026-07-20):
  - https://www.cpuc.ca.gov/about-cpuc/divisions/news-and-public-information-office/consumer-affairs-branch/consumer-complaints-and-inquiries-statistics (fetched; communications data by company, PDF, most recent shown 2019)
  - NY and TX verdicts are search only, primary fetch UNVERIFIED. Jurisdiction limits (NY sends cellular to the AG, TX does not regulate wireless) came from search results, not a clean agency-page fetch this session.
- Notes: California is the only one worth an investigator's time, and even there the value is limited. The data is company-named but old on the public page, lumps wireless in with wireline under "communications," and ships as PDFs you must parse by hand. Verdict per state: CA = weak LEAD, company-named but stale and PDF-bound, confirm current-year files exist before investing. NY = NO usable wireless data, jurisdiction sits with the AG. TX = NO usable wireless data, jurisdiction sits with the FCC. If you want carrier-named California figures, request current CAB monthly reports directly rather than relying on the stale web posting.

---

### 8. Google Programmable Search Engine, Custom Search JSON API
- Tier call: NO GO. Do not build on this. It is closed to new customers and is being shut down.
- Access method: https://developers.google.com/custom-search/v1/overview and the cse.list reference.
- Auth: API key plus a Programmable Search Engine ID.
- Available fields: per result, title, link, snippet, and display link. Storing only title, link, and date is technically fine field-wise. Site-restricted queries are supported through the siteSearch and siteSearchFilter parameters, so site:reddit.com scoping works.
- Location granularity: not applicable.
- License and usage terms: the specific Custom Search API terms language on storing or caching result metadata was NOT fetched this session, so that point is UNVERIFIED. Flag: Google API terms commonly restrict long-term caching of results; confirm the exact clause before storing anything beyond a short window.
- Rate limits and cost: 100 free queries per day. Overage is 5 dollars per 1000 queries, capped at 10,000 queries per day. COST FLAG on any use beyond the free 100 per day.
- Update frequency: on demand.
- Verified (fetched 2026-07-20):
  - https://developers.google.com/custom-search/v1/overview (fetched; 100/day free, 5 dollars per 1000 up to 10k/day, and the notice that the API is closed to new customers with discontinuation on January 1, 2027)
  - https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list (fetched; siteSearch and siteSearchFilter parameters confirmed)
  - https://developers.google.com/custom-search/v1/site_restricted_api (fetched; the site-restricted variant already ceased serving on January 8, 2025)
- Notes: Two shutdown facts kill this path. The main JSON API is closed to new customers and stops on January 1, 2027. The site-restricted variant already stopped in January 2025. Google points new users to Vertex AI Search, which is a different, paid product. So even though site:reddit.com scoping and metadata capture would work on paper, do not build a new listener here. COST FLAG stands on any paid query. Recommendation: skip.
- Google Alerts RSS as a free alternative: viable to set up. In Google Alerts, set "Deliver to" to RSS Feed with "How often" set to as-it-happens, then copy the feed URL. Verified from a fetched vendor how-to only in part; the Reddit coverage and reliability question has no Google first-party documentation. Google publishes no coverage or reliability guarantee for Alerts, and none was found this session, so Reddit coverage through Alerts is UNVERIFIED and should be treated as best-effort, not complete.

---

### 9. Reddit RSS feeds as a zero-cost listener
- Tier call: NO GO for automated polling. The feeds are throttled to near-uselessness and the User Agreement bars automated collection.
- Access method: historically https://www.reddit.com/r/ATT/new/.rss and search feeds.
- Auth: none for the plain feed, but authenticated feeds are now the workaround people use.
- Available fields (historically): Atom entries with title, link, author, updated or published date, and id. NOT confirmed live this session, see below.
- Location granularity: none.
- License and usage terms: Reddit's User Agreement prohibits using automated scripts to collect information from Reddit without permission, and bars bypassing rate limits. This is separate from the paid Data API terms. Plain RSS is not a licensed data channel; it is the public web interface, and automated polling of it violates the User Agreement.
- Rate limits: Reddit throttled RSS around June 11, 2025 to roughly 1 request per minute per feed, down about 97 percent from the prior allowance, and feeds return HTTP 429 under load.
- Update frequency: whenever the subreddit posts, but you can only pull about once a minute per feed.
- Verified (fetched 2026-07-20):
  - Live fetch of https://www.reddit.com/r/ATT/new/.rss FAILED. Our fetch tool is blocked from reddit.com entirely, and old.reddit.com too. So whether the feed returns valid XML today from a plain fetch is UNVERIFIED by us. The block itself is a signal that Reddit is fencing off non-browser access.
  - Supporting, search only, primary fetch UNVERIFIED: the June 2025 throttle to about 1 request per minute, and the User Agreement ban on automated scripts.
- Notes: Be precise, since the task asked for it. Two different regimes. One, the Reddit Data API, is a licensed, rate-limited, terms-bound product. Two, plain .rss feeds are the public web surface, and Reddit's User Agreement still forbids automated collection there. Neither gives us a clean, cheap, terms-safe listener. The RSS path is a NO GO for a polling collector. If the team wants Reddit signal, the only clean options are the official Data API under its terms, or a human reading threads and hand-citing them with Save Page Now. Do not stand up an RSS poller.

---

## Bottom line for the builder
- Publish-ready today: AAA and JAMS arbitration files, SEC EDGAR, and our own Wayback tooling.
- Investigation leads only: FCC FOIA, CourtListener class action alerts, California CPUC PDFs.
- Do not build: carrier forum scrapers, Google Custom Search, Reddit RSS pollers.
- Recheck from a real browser or a compliant client, because our fetch tool was blocked this session on sec.gov, fcc.gov, and reddit.com.
