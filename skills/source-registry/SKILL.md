---
name: source-registry
description: Approved data sources for Carriers On Notice, two-tier (evidence and leads), with access rules. Verified 2026-07-20. Only sources listed GO here may be collected from.
---

# Source Registry

Two tiers. Evidence feeds public numbers. Leads feed the internal investigation queue only and never feed a public count until independently verified. Full detail with verified URLs sits in SOURCE-REGISTRY.md and the track-a files.

## Evidence tier, approved for collection

- AAA consumer arbitration file (quarterly Excel, company named, adr.org/ConsumerArbitrationStatistics)
- JAMS consumer case file (quarterly, jamsadr.com/consumercases)
- SEC EDGAR full text search and data.sec.gov APIs (10 req/sec, required User-Agent "CompanyName email")
- FCC ECFS API (publicapi.fcc.gov/ecfs/filings, free api.data.gov key, 1,000 req/hr)
- FTC press release RSS (ftc.gov/feeds/press-release.xml and press-release-consumer-protection.xml) plus Legal Library
- FCC complaint dataset (opendata.fcc.gov resource 3xyp-aqkj, Socrata token for bulk). HARD LIMIT: no carrier name field. Never present its numbers as per-carrier.
- CourtListener / RECAP API v4 (token auth, 5/min 50/hr 125/day free, quarterly bulk dumps on S3, content license CC BY-ND: quote and link, never repackage)
- State AG: California RSS (oag.ca.gov/news/feed) confirmed. Other states and the NAAG and attorneysgeneral.org databases need verification before wiring in.
- News discovery: GDELT DOC 2.0 (1 request per 5 seconds) and Google News RSS. Store headline, source, date, link only. Never article bodies.
- Wayback CDX and Save Page Now (archive-at-capture engine, S3 keys for SPN2)
- Bluesky / AT Protocol (public.api.bsky.app searchPosts, firehose with delete events). Aggregate mention counts may go public with methodology. A single post's claim is a lead until vetted. Delete-event consumer required before storage.
- Hacker News Algolia API (hn.algolia.com, free, no key). Same aggregate-vs-claim rule. Confirm rate limit at build.

## Leads tier, investigation queue only

- FCC FOIA requests for carrier-named complaint records
- CourtListener search alerts for new carrier litigation
- California CPUC monthly reports (request current files directly, public page is stale)
- Carrier forum threads: hand read, hand cite, Save Page Now. Never crawl. AT&T forum is dead, use Wayback.
- Google Alerts RSS as a best-effort tip feed
- YouTube comments via Data API v3: discovery only, hard 30-day expiry, delete within 7 days of a user request, never a record store
- Apple app review RSS feed for carrier apps (confirm fields and terms at build)
- Mastodon public reads (per-instance terms, pick instances deliberately). Lemmy parked, volume too thin

## NO GO, closed

CFPB (wrong jurisdiction). BBB (ToS and robots forbid). Google Custom Search JSON API (shut down Jan 1, 2027). Reddit, all paths, closed by founder decision 2026-07-20: no Data API application, no RSS polling, no listeners. Carrier forum scraping. Class action aggregator scraping (ClassAction.org ToS forbids). Google Play reviews (own-apps-only API). X API (about $0.005 per post read, closed on budget).

## Access rules, bind regardless of source

1. Public and API-first only. Respect ToS and robots.txt. If a source cannot be collected cleanly, drop it and log why.
2. Every record stores its source URL, capture date, and excerpt.
3. Confirm current fields, location granularity, licensing, and rate limits before ingest.
4. Archive every cited page: Save Page Now plus local snapshot at capture time.
5. Aggregate, do not profile. No usernames, no consumer-level personal data.
