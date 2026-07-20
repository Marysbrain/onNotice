# Resilience plan. No single phone call kills anything.

Threat model: well funded opponents pressure chokepoints. The host, the registrar, the code host, the founder. Defense is redundancy, portability, and accuracy. Nothing here is exotic. Exotic breaks. Boring survives.

## The evidence (already strong, two additions)

Today: R2 primary vault, Wayback Machine independent public mirror on every capture.

1. Cold copy. Monthly sync of the whole R2 bucket and a D1 SQL dump to a local drive. One rclone command and one wrangler export, on a calendar reminder. Evidence then lives in your cloud, a nonprofit archive, and your hand.
2. Hash manifests plus OpenTimestamps. Each month, generate a manifest of SHA-256 hashes of every archived file, timestamp it with OpenTimestamps (free, anchors to Bitcoin, no coins involved, no COST FLAG). This proves any file existed on a date and was never altered. The answer to "that page never said that."

## The torrent leg (at launch, quarterly)

A public evidence bundle: government documents, court records, terms captures and diffs, aggregates, methodology. Released as a torrent with the magnet link on the site and in the digest. Seeded once, recallable never.

HARD BOUNDARY: bundles contain zero social records, zero user stories, zero anything carrying a deletion obligation. Deletion honoring is a promise; torrents cannot keep it. Library only.

## The site (portable by design)

The site is a static folder. It deploys to Cloudflare today and to any static host tomorrow: GitLab Pages, Netlify, a box in a closet. Twice a year, do a restore drill: build the site, deploy it to a spare target, confirm it works, tear it down. A backup you have never restored is a hope, not a backup.

Domain: keep registrar lock on. Consider a second domain at a different registrar parked as a fallback pointer (COST FLAG, roughly another ten dollars a year, founder call).

## The accounts (the quiet attack surface)

1. Strong unique passwords and hardware-key or app 2FA on: the uglymethod Google account, both Cloudflare accounts, GitHub, and the archive.org account. The uglymethod account matters as much as any of them; it anchors the CON Cloudflare login.
2. Recovery methods checked twice a year. An attacker who can reset your email owns everything downstream.
3. Scoped tokens only, no Global API Key anywhere, review token list quarterly and revoke strays.

## The person (the real chokepoint)

1. Accuracy is the armor. Every public claim sourced, commentary labeled, corrections fast and visible. A suit against sourced facts and labeled opinion is a loser, and discovery cuts both ways: suing us means opening their books.
2. If legal threats arrive: do not respond alone, do not take posts down in panic. The corrections policy is the response to accuracy claims. Consult a lawyer for anything beyond that. Anti-SLAPP statutes exist in most states for exactly this.
3. The bus factor: document everything (done, it is all in this folder), and consider a trusted second person holding emergency access instructions in a sealed envelope. Founder call.

## What we deliberately do not do

No IPFS pinning services (cost and complexity for what Wayback plus torrents already give). No on-chain storage (wrong tool). No offshore bulletproof hosting (signals bad faith and we are not doing anything that needs it). The strength of this project is that it is clean, sourced, and boring to attack.

## Build items when approved

1. Backup job additions to signal-engine: monthly manifest generation with SHA-256 hashes written to R2 and timestamped via OpenTimestamps.
2. Cold copy runbook: exact rclone and wrangler d1 export commands.
3. Bundle builder: quarterly job assembling the public evidence bundle and its .torrent file.
4. Restore drill runbook.
