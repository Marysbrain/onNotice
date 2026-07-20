# Carriers On Notice. Build plan for Tracks B through I.

One page. Order of build, what each track ships, and every cost flagged before it is committed.

## Step zero, before any track

New Cloudflare account for this project only, separate from the Stride gateway account. Same email, account switcher, zero cost. Register carriersonnotice.com through Cloudflare Registrar. COST FLAG: the .com registration and renewal, roughly ten dollars a year at Cloudflare's at-cost pricing. I will confirm the exact price at purchase time before you pay. Verify current Workers, D1, R2, and KV free tier limits on the day we start Track B and record them in the repo.

## Build order and what each ships

1. Track B, signal engine. First because everything downstream eats its output. Collectors as scheduled Workers for the evidence-tier sources: AAA and JAMS quarterly arbitration files (the per-carrier dispute counts, company named by law), SEC EDGAR full text (carrier promo economics in their own filings), FCC complaint dataset, FCC ECFS, FTC RSS, CA AG RSS, Google News RSS, GDELT. CourtListener via quarterly bulk dumps, targeted API lookups inside the free rate, and search alerts for new carrier litigation. Social listeners: Bluesky (searchPosts plus a firehose delete-event consumer, built before anything is stored) and Hacker News Algolia. Aggregate mention counts may go public with methodology; any single post's claim routes to the leads queue. Discovery-only tip feeds, no permanent storage: YouTube comments (hard 30-day expiry), Apple app review feed, Google Alerts RSS, Mastodon. Reddit is out, founder decision 2026-07-20. X is out on cost. The terms snapshotter: scheduled captures of each carrier's promo pages and offer terms into R2, with diffs stored in D1, plus Wayback CDX backfill of promo page history from before we started. Keyword taxonomy checked in as data, not code. Job table in D1 on the free tier, small idempotent chunks.

2. Track C, classification and cross reference. Runs once records flow. Cheap model tagging through Workers AI or Haiku behind AI Gateway. Confidence bar routes low scores to your review queue behind Cloudflare Access. Vetting statuses: verified primary source, corroborated, single source, disputed. Only the first two feed public numbers.

3. Track I, site legal basics. Drafted while C runs, because nothing public launches without it. Privacy policy, terms of use, submission consent, moderation standards, corrections policy, not legal advice disclaimer. All plain language, all reviewed by you.

4. Track D, evidence library. The citable core: regulatory timeline with primary documents attached, litigation tracker, terms archive with diffs, indexed news, complaint aggregates. Stable URLs and a citation block on every page.

5. Track E, heat map site, plus the Distribution Kit (track-e/distribution-kit-spec.md): the /tell intake URL, story pages people can share back into their own groups, copy-paste blocks and share cards on every page. Inbound and outbound, one loop, zero new infrastructure. The front door. US map from pre-aggregated JSON published by the pipeline, so serving stays static and free. Filters, verified count, methodology page, story submission form with Turnstile and consent, corrections page. Every displayed number links to its source. IMPORTANT LIMIT from Track A: the FCC public dataset has no carrier name field, so the map's FCC layer shows wireless billing complaint concentration, not per-carrier counts. Per-carrier numbers come from the arbitration files (company named by law), litigation dockets, ECFS comments, and vetted stories. The methodology page says this plainly. Map marker decision (Michael, 2026-07-20): base layer is a heat-colored choropleth, and flame markers sit on top of the hottest concentrations only, sized by intensity. Flames mark the leaders, never one per complaint. The flame is the brand mark across the site. Flames toggle on and off, every flame is clickable, and the Rabbit Hole spec (track-e/rabbit-hole-spec.md) defines the exploration layer: hot spot panels, follow-this threads over Track C's connection links, breadcrumb trails in the URL, progressive zoom. Sourced records at every node, no gamification.

6. Track F, take action hub. FCC informal complaint guide, state AG links, a verified dispute page per carrier with its notice of dispute address checked against the carrier's own current terms. Templates that prompt people to write their own facts. No copy paste mass filings.

7. Track G, announcements. Recurring digest once the pipeline has produced at least one full period of vetted data. Every claim linked.

8. Track H, short form campaign. Scripts and cut lists for your studio, in your voice. Starts as soon as Track D has citable pages to point at, because every video ends by sending people somewhere.

## Standing cost flags

Domain registration and renewal, flagged above. Possible Free Law Project membership only if litigation alerting needs more than the free 125 API calls a day, and the free quarterly bulk dumps are the default answer. Paid Workers plan only if volume outgrows the free job table pattern. Nothing else costs money. Anything new that would gets flagged to you before it is built.

## How the swarm runs it

Every track is dispatched to Opus 4.8 subagents with the three skills in the brief. I review every deliverable against the guardrails, send corrections once, fix it myself on a second miss. Nothing publishes and no number displays until I have traced it to its source record. Anything ambiguous about message, money, or a person comes to you.
