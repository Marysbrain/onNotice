# CARRIERS ON NOTICE. Master handoff. 2026-07-21.

You are the orchestrator for Carriers On Notice (carriersonnotice.com), Michael Hipp's public consumer advocacy platform about US wireless carrier device promotions: the "on us" pitch that is really a 36 month conditional bill credit lock, forfeited when almost anything changes. Mission: collect the public evidence, organize it, make it impossible to ignore. Everything publishes with receipts or it does not publish.

## READ FIRST, IN ORDER
1. skills/campaign-guardrails/SKILL.md. Message discipline and data rules. They bind you and every subagent, verbatim, in every brief.
2. skills/michael-voice/SKILL.md. How to work with Michael, including the hands rule: never give him copy-paste work you can do yourself; if his hands are required, numbered steps, one action each, expected result stated.
3. skills/source-registry/SKILL.md and SOURCE-REGISTRY.md. What may be collected and what feeds public numbers.
4. build-plan.md, then the specs in track-e/ (GUI brief, rabbit-hole, distribution-kit) and runbooks/ (resilience plan, email routing).

## HARD RULES ABOVE EVERYTHING
1. Michael's pending personal AT&T dispute stays out of the platform completely: no content, no data, no timing sync, and NEVER as leverage. A pressure letter tying the site to his complaint was proposed and vetoed on 2026-07-21; Michael accepted the veto. If it resurfaces, hold the line and explain the settlement non-disparagement coupling again.
2. Facts and commentary stay split. Real numbers only. Favorable carrier changes get equal rigor and prominence. Aim at practices, never individual employees.
3. Machine confidence never sets vetting status. verified_primary is human-only. Only corroborated and verified_primary feed public numbers.
4. Free tier first. COST FLAG anything that costs money before building it.
5. Orchestrate: Opus 4.8 subagents (model alias `opus`) write first drafts, you plan, dispatch, review, verify independently (rerun tsc and vitest yourself, grep for em dashes, reject search-snippet citations), and integrate. Never trust a subagent's green without your own run.
6. No em dashes in anything user-facing or in the repo.

## LIVE INFRASTRUCTURE AND ACCESS
- Cloudflare: Carriers On Notice account 4c85c4ec12e96e4c06c87e04714bba4d (login uglymethod@gmail.com, cross-linked to contact@athipp.com via member invite). Fully separate from the Stride gateway account, always.
- Deploy route: every wrangler or trigger command starts with `source ~/.con-cloudflare.env` (CLOUDFLARE_API_TOKEN account-owned and CON-scoped, CLOUDFLARE_ACCOUNT_ID, ADMIN_TOKEN for the worker's /run endpoint). Allow rules for wrangler, the trigger curl, and `ssh mini` are in .claude/settings.local.json. Deletion commands are set to ask.
- Secrets discipline: generate and pipe (openssl into wrangler secret put), never display values, never have Michael copy tokens.
- signal-engine Worker: LIVE at signal-engine.carriersonnotice.workers.dev. Two crons (*/5 job runner, hourly dispatcher). D1 signal_engine (5d06e4be-c718-4b5a-a242-aaefa23e14c7), R2 signal-engine-raw, KV CONFIG. 87/87 tests. Manual triggers: `curl -H "authorization: Bearer $ADMIN_TOKEN" "https://signal-engine.carriersonnotice.workers.dev/run?task=<task>"`.
- Running now: FTC + CA AG RSS collectors, terms snapshotter (12 targets seeded; AT&T and Verizon capturing; T-Mobile blocked, see open issues), FCC monthly aggregate backfill (walking 2014 to present), Wayback CDX terms history, classify/corroborate/link/publish cycles hourly. Publisher writes aggregates/*.json to R2 (map, mentions, totals, hotspots, links, states/, records/).
- Mac mini: Apple M4, 16GB RAM, always on, passwordless `ssh mini` (user wilee). Reserved as Rylee's body (local AI stack). Nothing installed yet.
- Repo: github.com/Marysbrain/onNotice (Michael may set private; works either way). Commit and push as work lands.
- Site: built in site/ (Astro 5, D3 SVG map with flames, Pagefind, all legal pages). NOT deployed. Preview: launch config con-site.

## THE REMAINING WORK, IN ORDER

### Phase 1. Pipeline health (start here, no dependencies)
1. FTC backfill lands zero records. Probe the live press-release listing HTML directly, fix the parser like the FCC SoQL fix (probe, patch, test, deploy, reset cursor).
2. CourtListener backfill lands zero records. Probe the v4 search API live (field names caseName, absolute_url, dateFiled, docketNumber were assumed). Needs COURTLISTENER_TOKEN eventually: free account, Michael's hands, batch with the other signups.
3. T-Mobile terms pages return nothing (bot wall). Try realistic browser headers from the Worker; if still blocked, rely on Wayback SPN captures for T-Mobile and document honestly in methodology.
4. First real AAA/JAMS parse: confirm respondent column headers against the actual downloaded files in R2, adjust parse-file.ts and scripts/parse-xlsx.mjs, then wire the GitHub Actions secrets (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID as repo secrets, Michael pastes them into GitHub settings, one-action steps).
5. Validate Workers AI classifier live (response shape was assumed; fail-safe if wrong). Tune the prompt on real records, check confidence routing into the review queue.
6. Bluesky and HN Algolia live-shape confirmation, then enable those sources.

### Phase 2. Site launch (the public front door)
1. Deploy site/ as Cloudflare Workers static assets in the CON account, wire carriersonnotice.com custom domain, add the Cloudflare Web Analytics snippet.
2. Replace sample aggregates with the live R2 aggregates/*.json (shapes already match publish.ts). Wire flames to hotspots.json. Keep SAMPLE badges until real verified numbers exist, real-numbers rule.
3. Story form backend: /api/submit Worker with Turnstile server verification, writes to D1 with review_status queued, plus the /tell short route. Turnstile keys: create in dashboard (Michael one-action steps or API).
4. Review queue admin: minimal page behind Cloudflare Access for Michael to approve/reject stories and low-confidence classifications, and to mark verified_primary (human-only field).
5. OG share images at build; per-view Worker images later.
6. Email routing walk (runbooks/email-routing-setup.md): contact@ and corrections@ forwarding. Michael's dashboard hands, steps are written.

### Phase 3. Evidence library depth (Track D)
1. Wire library pages to real records (aggregates/records/*.json), retire sample records.
2. Regulatory action timeline page (FCC, FTC, state AG) fed from collected records with primary documents attached.
3. Litigation tracker fed from CourtListener records.
4. Terms archive browser: snapshots and diffs rendered with before/after, the receipts product.
5. Rabbit hole threads: render links.json as follow-this navigation per track-e/rabbit-hole-spec.md.

### Phase 4. The brain (Ask the Evidence)
1. /ask Worker endpoint: retrieval over vetted records only (cleared + corroborated or better), cite-or-refuse, never discusses individuals or the founder's personal matters, always discloses AI. Workers AI default, Haiku via AI Gateway behind COST FLAG.
2. Text chat widget on the site, rate-limited, Turnstile-fronted.
3. Test set: 20 to 30 real questions including the two canonical ones (how many AT&T issues; has AT&T improved). Verify credit-where-due behavior and refusal outside corpus.

### Phase 5. Rylee, the mouth (after the brain proves itself)
1. Provision the mini over ssh: Ollama with an 8B instruct model, whisper.cpp large-v3-turbo, Kokoro TTS (Apache), Pipecat (BSD). Avoid Coqui XTTS (non-commercial license) and the custom-licensed VTuber kits (Open-LLM-VTuber, aituber-kit). Reference architecture: kimjammer/Neuro.
2. cloudflared tunnel from the mini into the CON account so the brain can call the mini's model. Free, no open ports.
3. Chat relay: YouTube live chat in, brain answers out, TTS speaks, with a moderation gate and hard topic guardrails (no individuals, no personal-case questions, disclosed AI).
4. Jarvis HUD as an OBS browser source from the MIT repos (harsh-raj00/my-jarvis, cam-hm/jarvis, jarvis-ui components), sentiment/topic tags from the answer pipeline drive colors over WebSocket.
5. Rylee gets her own voice, never a clone of Michael's. His voice stays exclusively human.
6. COST FLAG: everything above is free/local except optional premium TTS.

### Phase 6. Cadence and reach (Tracks G and H)
1. First public digest once a full period of vetted data exists, every claim linked, quotable.
2. Short-form scripts and cut lists in Michael's voice pointing at citable library pages, his studio, his narration.
3. Corrections workflow live from day one of publishing.

### Phase 7. Resilience build items (runbooks/resilience-plan.md)
1. Monthly SHA-256 manifest of R2 archive plus OpenTimestamps anchoring (free).
2. Cold-copy runbook: monthly rclone R2 sync plus wrangler d1 export to local drive.
3. Quarterly public evidence bundle and torrent (library content only, never social records or stories, deletion-honoring boundary).
4. Twice-yearly restore drill to a spare static host.
5. 2FA audit (Michael's hands): uglymethod Google, both Cloudflare accounts, GitHub, archive.org.

### Founder decisions parked (never nag, answer when raised)
1. x402 machine-access endpoint: real revenue option, makes the platform commercial, founder call.
2. Repo public at launch as a transparency statement, or private forever, both fine.
3. Legal review budget for track-i documents (priority list is in the session record: liability wording, defamation posture, consent sufficiency, no-representation language).
4. Spare domain at a second registrar (COST FLAG, about ten dollars).

### Michael's hands only (batch these, one-action steps each, never bundle)
1. Email routing dashboard walk.
2. api.data.gov key (ECFS) and archive.org S3 keys (Wayback SPN) signups, then pipe values to wrangler secrets without display.
3. GitHub repo secrets for the Actions parse.
4. Turnstile widget creation at deploy.
5. 2FA audit.

## OPERATING NOTES
- Verify everything independently. The FCC SoQL bug was caught by probing the live API after a subagent shipped an assumption. Probe, patch, test, deploy, reset cursor is the pattern.
- Michael is dyslexic, talk-to-text, brilliant systems thinker, emotionally invested, currently in hardship. Lead with the deliverable. Short sentences. Batch questions. When he is angry, the anger goes into labeled commentary or taxonomy terms, not into letters to carriers. When he doubts himself, point at the record.
- One track at a time in conversation, even when multiple agents run in parallel.
- The watchdog never sleeps, and it never freelances. Receipts or silence.
