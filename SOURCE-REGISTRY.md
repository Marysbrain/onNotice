# Carriers On Notice. Source Registry. Final, v1.

Two tiers. Evidence feeds public numbers. Leads feed the investigation queue only.
Detail files with every field, verified URL, and capture date:
- track-a/source-registry-DRAFT.md (core sources, corrected and accepted 2026-07-20)
- track-a/leads-sources-DRAFT.md (investigative sources, accepted 2026-07-20)

## Evidence tier. May feed public numbers.

| Source | Status | What it gives us | Key limit |
|---|---|---|---|
| AAA consumer arbitration file | GO | Per-carrier dispute counts, company named by law, quarterly Excel | Confirm respondent column and reuse terms on first download |
| JAMS consumer case file | GO | Same, second arbitration provider | Same first-download check |
| SEC EDGAR full text + APIs | GO | Carrier disclosures on promo economics, churn, upgrade cycles | Needs compliant User-Agent client, 10 req/sec |
| FCC ECFS API | GO | Docket filings and full comment text | No location data |
| FTC RSS + Legal Library | GO | Enforcement actions, public domain | Document level, no complaint table |
| FCC complaint dataset (Socrata) | GO WITH LIMITS | Wireless billing complaint volume by city, state, zip, nightly | NO carrier name field. Never present as per-carrier |
| CourtListener / RECAP | GO WITH LIMITS | Filed complaints and dockets, company named | 125 free API calls/day, quarterly bulk dumps for backfill, BY-ND license, quote and link only |
| State AG monitoring | GO WITH LIMITS | Settlements and enforcement, CA RSS confirmed live | NAAG and attorneysgeneral.org databases still UNVERIFIED |
| News (GDELT + Google News RSS) | GO WITH LIMITS | Discovery, headlines, links | Metadata and links only, no article bodies |
| Wayback CDX + Save Page Now | GO | Historical promo page reconstruction, archive-at-capture engine | Confirm SPN2 rate limits from authenticated account |
| Bluesky / AT Protocol | GO | Public post search and firehose, real delete events, permissive terms | Aggregate mention counts only may go public. Any single post's claim is a lead until vetted. Build the delete-event consumer before storing |
| Hacker News Algolia API | GO | Free full-text search over comments, no key, confirmed live | Same rule: counts publishable with methodology, individual claims are leads. Rate limit community-reported, confirm at build |

## Leads tier. Investigation queue only. Never feeds a public count.

| Source | Status | Play |
|---|---|---|
| FCC FOIA channel | OPEN | Request carrier-named complaint records. The public dataset strips company names. FOIA is the only path to per-carrier FCC counts. Slow, uncertain, worth filing |
| CourtListener search alerts | ACTIVE PATH | Alerts on carrier names plus promo terms surface new class actions as filed. Cleaner than aggregator sites, which ban automation |
| California CPUC reports | WEAK | Company-named but PDF-bound and stale on the public page (2019). Request current monthly reports directly before investing |
| Carrier forum threads | HAND ONLY | No scraping. One thread, one hand citation, Save Page Now. AT&T forum is dead, use Wayback for its history |
| Google Alerts RSS | BEST EFFORT | Free listener, coverage not guaranteed, no first-party docs. Use as a tip feed, never as coverage |
| YouTube comments (Data API v3) | DISCOVERY ONLY | Free quota, but Google caps unauthorized data retention at 30 days and requires deletion within 7 days of a user request. Use as a rolling tip feed with hard 30-day expiry, never as a record store |
| Apple app review feed | OPEN | Public RSS of carrier app reviews, billing complaints land there. Confirm per-review fields and terms at build |
| Mastodon | OPEN | Public reads, 300 req/5min, but terms are per-instance. Pick instances deliberately |
| Lemmy | THIN | Clean open API, near-zero carrier volume today. Park it |

## NO GO. Logged and closed.

| Source | Why |
|---|---|
| CFPB complaint database | Wrong jurisdiction. Financial products only. Wireless billing sits with FCC and FTC |
| BBB complaint pages | ToS is personal non-commercial only, robots blocks complaint pages |
| Google Custom Search JSON API | Closed to new customers, full shutdown January 1, 2027. Site-restricted variant already dead |
| Reddit, all paths | Founder decision 2026-07-20. Data API terms unverifiable and likely commercial-blocked, RSS throttled and ToS-barred, listeners dead. Replacement: story form plus hand citation |
| Carrier forum scraping | ToS and robots forbid it on all three |
| Class action aggregator scraping | ClassAction.org terms explicitly ban crawling and data mining |
| Google Play reviews | Reply to Reviews API is own-apps-only. No permitted path to carrier app reviews |
| X API | Pay-per-use, about $0.005 per post read, roughly $10,000/month at the 2M read cap. COST FLAG, closed on budget |

## Provisional. Decision pending.

None. Reddit was the only provisional source and Michael closed it on 2026-07-20.

## Open items before build

1. Download the actual AAA and JAMS files once, confirm respondent column headers and any reuse terms.
2. Re-confirm SEC User-Agent rule from sec.gov with a compliant client.
3. Verify NAAG and attorneysgeneral.org databases from a real browser.
4. Read the ECFS doc page and ftc.gov/developer from a real browser.
5. Confirm current-year CPUC report availability.
6. Confirm SPN2 rate limits from an authenticated archive.org account.
