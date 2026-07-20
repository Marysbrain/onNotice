# Track A: Social Signal Sources (DRAFT)

Replacements for Reddit as a social listener. Reddit is closed by founder decision, all paths, not revisited here. Bar for inclusion: public group conversations about carrier bill credit clawbacks, collected cleanly.

Capture date for every fetch: 2026-07-20. Primary fetches only. A search snippet was never treated as proof. Where a page would not load or our fetch tool was blocked, dependent claims are marked UNVERIFIED inline. COST FLAG marks anything paid.

## Summary table

| # | Source | Tier call | One line reason |
|---|--------|-----------|-----------------|
| 1 | Bluesky / AT Protocol | EVIDENCE (priority) | Public unauth reads, full firehose with real delete events, permissive terms |
| 2 | Hacker News Algolia API | EVIDENCE | Free, no key, full-text over comments, confirmed live |
| 3 | YouTube Data API v3 | LEADS | Works, but 30-day retention cap and deletion duties make storage heavy |
| 4 | App store reviews | LEADS (Apple) / NO GO (Google) | Apple RSS feed is alive and public; Google Play is own-apps-only |
| 5 | Mastodon | LEADS | Public reads exist but are per-instance, with per-instance terms |
| 6 | Lemmy | LEADS (thin) | Clean public API, but carrier-topic volume is very low |
| 7 | X API | NO GO | Pay-per-use, about $0.005 per post read, capped at 2M reads/month |

---

### 1. Bluesky / AT Protocol
- Tier call: EVIDENCE. Priority source. Public reads, clean terms, and the best deletion story of the whole set.
- Access method:
  - Public unauthenticated AppView reads: https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts (also getAuthorFeed, getPostThread, getProfile).
  - API reference: https://docs.bsky.app/docs/api/app-bsky-feed-search-posts (301 redirects to https://endpoints.bsky.app/).
  - Firehose (full network): the AT Protocol sync stream of repo commits. Jetstream is the lightweight JSON option layered on top.
- Auth:
  - Reads via public.api.bsky.app: no auth, per Bluesky's documented public AppView. UNVERIFIED by our tool: our live call to public.api.bsky.app returned HTTP 403 to the fetcher, which is a user-agent block on our side, not an auth wall. A normal client reaches it. Re-confirm with a real HTTP client.
  - Firehose / Jetstream: no auth for public consumption.
- Available fields: per post, uri, cid, author (handle and DID), record text, createdAt, and engagement counts. searchPosts accepts q, limit, cursor, sort, since, until. Company name and free text YES, you search on the words themselves, for example "bill credit" plus a carrier name.
- Location granularity: none reliable. Bluesky posts carry no location. Do not infer geography.
- License and usage terms: Bluesky ToS at https://bsky.social/about/support/tos (fetched). Two things matter. First, it does not restrict third-party reading of public posts and points developers to the open AT Protocol. Second, and important for us, it states that due to the decentralized nature of the protocol, Bluesky cannot force other services to treat content a particular way and some deleted posts may persist elsewhere outside its control. So the network is open, and deletion is our responsibility to honor, not something the ToS guarantees.
- Rate limits: public AppView reads are rate limited per IP, exact number UNVERIFIED (the docs page is a JS app our fetcher could not render). Firehose is a stream, not a request loop. Be polite and cache.
- Update frequency: real time via firehose. Near real time via searchPosts polling.
- Verified (fetched 2026-07-20):
  - https://docs.bsky.app/docs/api/app-bsky-feed-search-posts (fetched; 301 to endpoints.bsky.app, confirms the searchPosts reference exists)
  - https://bsky.social/about/support/tos (fetched; open network, cannot force deletion downstream, disclaims control of other services)
  - https://atproto.com/specs/sync (fetched; firehose commit events carry record ops with action create, update, or delete, a delete op shows action delete with cid null)
  - Live call to public.api.bsky.app searchPosts FAILED with 403 to our fetcher (user-agent block, not auth). Unauth confirmation UNVERIFIED by us.
  - https://raw.githubusercontent.com/bluesky-social/jetstream/main/README.md (fetched; returned a stale, pre-production description and no public instance list, so Jetstream public endpoints are UNVERIFIED this session)
- Notes: Could this feed the leads queue tomorrow? Yes, first in line. Poll searchPosts for carrier plus clawback terms, or better, tap the firehose and filter. To honor deletions if we store: this is the cleanest of the seven. The firehose emits explicit delete operations (action delete, cid null), so run a consumer that watches for deletes and drops the matching stored record. As a backstop, periodically re-resolve stored post URIs through getPosts and delete anything that returns not found. Build the delete consumer before you store a single post.

---

### 2. Hacker News Algolia API
- Tier call: EVIDENCE. Free, keyless, full-text over comments, and confirmed working live this session.
- Access method:
  - Search: http://hn.algolia.com/api/v1/search?query=...&tags=comment
  - Newest first: /api/v1/search_by_date
  - Single item and user: /api/v1/items/:id and /api/v1/users/:username
- Auth: none. No API key.
- Available fields (confirmed from a live response): per hit, objectID, comment_text, author, created_at, created_at_i, points, parent_id, story_id, story_title, story_url, and _highlightResult. Top level includes hits, nbHits, nbPages, page, hitsPerPage. Query supports tags (comment, story), numericFilters, page, hitsPerPage. Company name and free text YES.
- Location granularity: none.
- License and usage terms: UNVERIFIED. The official docs page at https://hn.algolia.com/api is a JS app our fetcher could not render, so I could not read a formal terms clause. The service is a public HN search with no key required, confirmed by a working call.
- Rate limits: reported at about 10,000 requests per hour per IP, returning HTTP 429 over the limit. That number comes from community sources, not the rendered docs page, so it is UNVERIFIED as a primary fact. Treat 10k per hour as a working ceiling and throttle well under it.
- Update frequency: near real time. HN items index quickly.
- Verified (fetched 2026-07-20):
  - https://hn.algolia.com/api/v1/search?query=bill%20credits%20AT%26T&tags=comment (fetched live; returned JSON, 2,828 comment hits, full-text match highlighted inside comment_text, no auth)
- Notes: Could this feed the leads queue tomorrow? Yes. It is the lowest-effort clean source in the set. Search "bill credit" and carrier names with tags=comment, keep objectID, comment_text, author, created_at, and the HN permalink. To honor deletions if we store: HN Algolia has no delete push. Re-query stored objectIDs on a schedule through /items/:id and drop anything that no longer resolves. Volume of carrier clawback talk on HN is modest but high quality, expect engineers describing the exact 36 month mechanic.

---

### 3. YouTube Data API v3 (commentThreads and search)
- Tier call: LEADS. It works and comments are rich, but the storage rules make it a heavy build.
- Access method:
  - Comments: commentThreads.list
  - Discovery: search.list
  - Base: https://www.googleapis.com/youtube/v3/
- Auth: Google API key for public read. OAuth only if acting on a user's behalf.
- Available fields: comment text, author display name, publishedAt, likeCount, and the parent video id. Company name and free text YES.
- Location granularity: none reliable.
- License and usage terms: YouTube API Services Developer Policies at https://developers.google.com/youtube/terms/developer-policies (fetched). Hard rules for us. Non-authorized API data may be stored for no longer than 30 calendar days, then must be deleted or refreshed. If a user asks you to delete their data, you must do it within 7 days. If a user revokes consent, delete within 30 days. The policies do not force automatic deletion when the source video or comment is removed, but they do force the 30-day retention cap and re-verification. Public display of comment excerpts is not explicitly addressed, so treat public republication as needing care and keep it to short quotes with attribution.
- Rate limits and cost: default quota is 10,000 units per day, shared across most endpoints. search.list has its own bucket of 100 calls per day. commentThreads.list costs 1 unit per call. More quota is by request form only. COST FLAG is soft here, the API is free, but the 100 search calls per day cap will throttle discovery and pushing past the daily quota needs an approval, not money.
- Update frequency: near real time.
- Verified (fetched 2026-07-20):
  - https://developers.google.com/youtube/v3/determine_quota_cost (fetched; commentThreads.list = 1 unit, search allocation limited)
  - https://developers.google.com/youtube/v3/getting-started (fetched; default 10,000 units per day, 100 search.list calls per day, more only by request)
  - https://developers.google.com/youtube/terms/developer-policies (fetched; 30-day retention cap, 7-day deletion on request, 30-day deletion on revocation)
- Notes: Could this feed the leads queue tomorrow? Yes for surfacing leads, no for a durable archive. The 30-day retention cap means you cannot legally keep YouTube comment bodies long term under this API. To honor deletions if we store: you must build a purge job no matter what, one that expires any YouTube-sourced record at 30 days and honors a user delete request within 7 days. Practical pattern, use YouTube only to find a lead, extract the fact, cite the video URL, and let the raw comment expire out of storage on the 30-day clock. Do not treat it as your system of record.

---

### 4. App store reviews (Apple and Google Play)
- Tier call: LEADS for Apple. NO GO for Google Play third-party reviews.
- Access method:
  - Apple: https://itunes.apple.com/us/rss/customerreviews/id=APPID/sortBy=mostRecent/json (public RSS/JSON per app).
  - Google Play: Reply to Reviews API at https://developers.google.com/android-publisher/reply-to-reviews, plus the In-App Review API. Neither reads arbitrary apps.
- Auth:
  - Apple: none.
  - Google Play: OAuth service account, and only for apps you own in your Play Console.
- Available fields:
  - Apple: the feed envelope is confirmed live (title "iTunes Store: Customer Reviews", a current updated timestamp, and first/last/next pagination links). Per-review fields typically include author name, im:rating, title, content, and im:version. UNVERIFIED this session: the fetched excerpt stopped at the envelope and did not reach individual review entries, so confirm the review field names against a full pull.
  - Google Play: for your own app only, review text, rating, and reply status.
- Location granularity: Apple feed is per storefront (the /us/ path). No finer geography per review.
- License and usage terms:
  - Apple: standard Apple Media Services terms. No explicit reuse license on the feed itself. UNVERIFIED wording.
  - Google Play: the Reply to Reviews API is scoped to your own app. Confirmed from the fetched page, it lets you access feedback only for production versions of your app. There is no permitted programmatic path to reviews of apps you do not own. So collecting carrier app reviews you do not control is a NO GO through Google's API.
- Rate limits:
  - Apple: not published on the feed. Poll politely, it is a static file per app.
  - Google Play: 200 GET requests per hour per app for your own apps. Not usable for us anyway.
- Update frequency: Apple feed refreshes as new reviews post. It exposes a limited recent window and paginates, not the full history.
- Verified (fetched 2026-07-20):
  - https://itunes.apple.com/us/rss/customerreviews/id=543597105/sortBy=mostRecent/json (fetched live; feed is alive, envelope confirmed, using the myAT&T app id as a test target)
  - https://developers.google.com/android-publisher/reply-to-reviews (fetched; access is limited to your own app's production reviews, 200 GET per hour)
- Notes: Could this feed the leads queue tomorrow? Apple yes, for the carrier apps, as a thin stream of recent reviews mentioning bill credits and clawbacks. Google Play no, not for apps we do not own. To honor deletions if we store: the Apple feed gives no per-review delete signal, so keep only what is in the current feed window, re-poll, and expire anything that ages out or disappears from the feed. Store minimal fields and the review permalink. Do not attempt Google Play review scraping, it is both blocked by the API scope and against Play terms.

---

### 5. Mastodon
- Tier call: LEADS. Public reads exist, but everything is per-instance, including the terms.
- Access method:
  - Public timeline: GET /api/v1/timelines/public
  - Search: GET /api/v2/search
  - Base is per instance, for example https://mastodon.social/api/v1/
- Auth:
  - Public timeline is commonly available without auth, but this is instance-configurable. UNVERIFIED as a blanket fact, the fetched rate-limit page did not state the auth requirement, and many instances gate search behind a token.
- Available fields: status content, account handle, created_at, and the status URL. Company name and free text YES.
- Location granularity: none reliable.
- License and usage terms: there is no single Mastodon ToS. Each instance sets its own rules, so terms vary per server. You must check the specific instance's about and terms before collecting from it. This per-instance variance is the main friction.
- Rate limits: default 300 requests per 5 minutes, applied per account and per IP. Media upload 30 per 30 minutes. Status deletion endpoint exists and is itself rate limited. Communicated via X-RateLimit headers.
- Update frequency: real time on the local and federated timelines.
- Verified (fetched 2026-07-20):
  - https://docs.joinmastodon.org/api/rate-limits/ (fetched; 300 requests per 5 minutes per account and per IP, delete endpoints exist)
- Notes: Could this feed the leads queue tomorrow? Yes, but pick one or two large instances and respect each one's terms rather than crawling the fediverse. Carrier clawback chatter is present but scattered. To honor deletions if we store: Mastodon does not push deletes to arbitrary third parties. Re-check each stored status id on a schedule, and when it returns 404, delete our copy. Track which instance each record came from so you can re-check against the right server. Confirm the public-read auth requirement on each target instance before ingest, since that is UNVERIFIED as a general rule.

---

### 6. Lemmy
- Tier call: LEADS, thin. Clean and open, but the volume is not there.
- Access method:
  - Public HTTP API at /api/{version}/, current is v3 moving to v4. List and search posts and comments, for example GET https://lemmy.ml/api/v3/post/list and /api/v3/search.
- Auth: none for listing and searching public content.
- Available fields: post and comment body, community, author, published date, and the permalink. Company name and free text YES.
- Location granularity: none.
- License and usage terms: no central ToS, each instance is self-hosted and sets its own rules. The API docs note IP-based rate limiting and recommend passing X-Forwarded-For for server-side callers. Confirm the target instance's own terms before ingest.
- Rate limits: IP based, per instance. Server-side callers on shared IPs can hit limits faster. Exact numbers vary per instance and were not stated as a single value.
- Update frequency: real time on the instance.
- Verified (fetched 2026-07-20):
  - https://join-lemmy.org/docs/contributors/04-api.html (fetched; versioned public API, unauth community/list example, IP rate limiting)
- Notes: Could this feed the leads queue tomorrow? Technically yes, practically low value. Honest read on volume: carrier and telecom communities on Lemmy are small, and US carrier bill-credit clawback talk is sparse to near zero. Set it up only if the crawler is cheap to run and you fold it into a broader search, do not build anything Lemmy-specific. To honor deletions if we store: same pattern as Mastodon, re-check the stored post or comment id per instance and delete on 404.

---

### 7. X API
- Tier call: NO GO. Priced out for our use, and capped.
- Access method: X API, pricing at https://docs.x.com/x-api/getting-started/pricing, console at https://console.x.com.
- Auth: paid credentials, credit-based account.
- Available fields: post text, author, timestamps, and metrics. Company name and free text YES. Not the blocker, cost is.
- Location granularity: mostly none usable.
- License and usage terms: standard X developer agreement, paid.
- Rate limits and cost: pay-per-usage, no subscription. Confirmed prices: post reads about $0.005 per resource, user reads about $0.010, likes and mutes and blocks about $0.001, post creation about $0.015. Pay-per-usage is capped at 2 million post reads per monthly billing cycle, higher needs Enterprise. COST FLAG: at $0.005 per post read, a 2 million read month runs to about $10,000. Any meaningful listening volume is expensive fast.
- Update frequency: real time.
- Verified (fetched 2026-07-20):
  - https://docs.x.com/x-api/introduction (fetched; pay-per-usage, no subscriptions, credit model)
  - https://docs.x.com/x-api/getting-started/pricing (fetched; $0.005 per post read, $0.010 per user, 2M post read monthly cap, xAI credit rewards tiers)
- Notes: Could this feed the leads queue tomorrow? No, not on a consumer-advocacy budget. The per-read price plus the monthly cap makes broad listening cost-prohibitive, which is the documented reason to keep it closed. To honor deletions if we store: not applicable, we are not ingesting. If a specific X post is ever cited by hand, treat it like any other web citation, save the URL and run an archive snapshot.

---

## Bottom line for the builder
- Build first: Bluesky. Public reads, open terms, and real delete events make it the cleanest listener and the best replacement for Reddit.
- Build second: Hacker News Algolia. Free, keyless, confirmed live, low effort.
- Use with limits: YouTube (30-day purge job mandatory), Apple review RSS (thin, feed-window only), Mastodon and Lemmy (per-instance terms, re-check on 404 to honor deletes).
- Do not build: X API (cost), Google Play third-party reviews (own-apps-only).
- Deletion rule that spans all of them: if we store any social post, we store the source URL and we run a re-check-and-purge job. Bluesky gets a firehose delete consumer. Everything else gets a scheduled re-resolve that drops any item returning not found. YouTube also gets a hard 30-day expiry regardless.
- Recheck note: our fetch tool was blocked (403) on public.api.bsky.app this session, the same kind of user-agent block seen earlier on sec.gov and reddit.com. Confirm Bluesky unauthenticated reads from a normal HTTP client before wiring the collector.
