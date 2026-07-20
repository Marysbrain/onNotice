# Distribution Kit spec. The two-way door.

Added 2026-07-20 from Michael's direction: closed communities (Facebook groups, Discord servers, group chats) cannot be listened to cleanly. So the platform becomes the destination they post INTO, and our content becomes easy to carry IN to those places. Inbound and outbound, one loop.

## Inbound. Make us the place they bring it.

1. Short memorable intake URL: carriersonnotice.com/tell. Mobile first, no account, Turnstile, consent language up front. One screen, talk-to-text friendly.
2. After a story is verified and scrubbed, it gets its own stable public page with a share card. The person who told it can post THEIR OWN story link back into their group. That is the loop: card comes in, story goes out, more people follow the card in.
3. A short "post this where you saw it" line on the story confirmation screen, inviting the person to share their story page back to wherever they first vented. Invitation only. No reward, no counter, no badge for sharing. The no-synthetic-amplification rule means we never pay, gamify, or script distribution.

## Outbound. Make our stuff easy to carry in.

1. Every map view, library record, and story page already ships a deep link and an Open Graph share image (GUI brief sections 4). Facebook and Discord unfurl those automatically. The card must carry one sourced fact, the site name, and nothing else.
2. Copy-paste block on every shareable page: two or three plain sentences stating the sourced fact plus the link. Facebook groups and Discord are paste cultures. One tap to copy.
3. Downloadable share graphics in the standard sizes, each stamped with the page URL. For people who share screenshots instead of links.
4. Wording rule: share text states facts with a source and invites people to tell their own story in their own words. It never hands people a pre-written complaint. Regulators discount copy paste floods, and identical text spreading through groups reads as astroturf. The kit spreads the link, not a script.

## Privacy rule

No tracking pixels, no per-person attribution, no individual analytics on shares. Cloudflare Web Analytics aggregate only. We do not follow people into their groups. We just make the door easy to find from inside them.

## Build notes

Inbound intake is already Track E scope (story form). The kit adds: the /tell short URL, the story confirmation share prompt, the copy-paste block component, and the downloadable card generator (build-time, same Satori pipeline as the OG images, zero new cost). Fold into Track E build. Zero new infrastructure.
