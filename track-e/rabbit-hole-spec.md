# Rabbit Hole spec. Map exploration for people who love to dig.

Added 2026-07-20 from Michael's direction. The map is not just a display, it is an entrance. Deep divers should be able to start at a flame and follow connected evidence for an hour. Exploration depth is the hook. No points, no badges, no progress bars for the visitor. The reward is what they find.

## Flame layer

1. Flames toggle on and off. A simple layer control on the map: Flames on / off. Off shows the clean choropleth for people who want the sober view, on shows the hot spots. Default on. The choice persists in the URL like every other map state, so a shared link shows what the sharer saw.
2. Every flame is clickable and keyboard reachable (real SVG node, Enter opens it, same as the geography drill-down in the GUI brief).
3. Clicking a flame opens the hot spot panel: what is burning here. The verified record count for that area, the top alleged issues, and the threads that start here.

## Threads. The side paths.

Built on Track C's connection layer, which already links records sharing a carrier, promo, time window, or claim type.

1. From a hot spot panel, every item offers "follow this": a promo name leads to the terms archive page with its diffs, a terms change leads to the litigation that cites similar language, a lawsuit leads to the news coverage, coverage leads back to other hot spots where the same promo burned. Each hop is one click.
2. A breadcrumb trail shows the path taken, so the diver can back out of any branch. The full trail state lives in the URL. A rabbit holer can share their exact path and someone else lands at the end of it with the trail intact.
3. Articles and records pop up as side panels, not page loads. The map stays underneath. Closing the panel returns to the map exactly where they were.
4. Zoom is progressive: national, state, county, metro. Deeper zoom reveals smaller flames that do not show at national level. Depth literally rewards zooming.

## The line we hold

1. Every node on every path is a sourced record with its citation block. The rabbit hole is made of receipts. That is what separates exploration from insinuation: the visitor draws their own conclusions from documents, we never draw the line for them with an unsourced visual.
2. Connections shown are the documented kinds only: same carrier, same promo, same terms language, same time window, same claim type. We never render a connection we cannot name in the methodology. No conspiracy-board string between things the data does not actually link.
3. No gamification. No score for depth, no achievement for path length, no leaderboard of divers. The design earns time-on-site with content, not mechanics.

## Build notes

Depends on Track C connection layer output: a links table (record_id_a, record_id_b, link_type, basis). Track E renders it. The flame toggle, hot spot panel, and URL trail state are pure frontend on the accepted Astro plus D3 stack. Panels reuse the drill-down side panel from the GUI brief. Zero new infrastructure, zero new cost.
