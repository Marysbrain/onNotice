# Rylee broadcast HUD

The on screen overlay for the Carriers On Notice broadcast. It is the desk
lower third and the citation panel that renders receipts while Rylee speaks.
This is the mouth's face, not the brain. It shows only what is sent to it.

Everything here is free and local. Vanilla HTML, CSS, and JavaScript in one
file, plus a small standard library Python bridge. No CDN, no build step, no
npm install, no framework. OBS loads the HUD as a browser source from disk.

## Files

- `hud.html` the overlay. 1920 by 1080, transparent background, for OBS.
- `hud_bridge.py` the WebSocket server that forwards events to the HUD.
- `check.js` static checks on the HUD. Run with node.
- `README.md` this file.

## The binding rules this HUD honors

1. No em dashes anywhere, on screen or in code.
2. The AI disclosure is always visible and cannot be removed by any state:
   "Rylee is an AI. Every claim cites the public record."
3. The citation panel is the product, not decoration. It carries the most
   visual weight.
4. Colorblind safe palette. Meaning never rides on color alone. Every state
   also carries a word or a shape.
5. Free and local. One HTML file plus assets that load from disk.

## Quick review with the demo, no other system running

You need Python 3 and, if you want the automated checks, Node.

1. Start the bridge in demo mode. It replays a canned sixty second script on a
   loop: a question, sentences, sentiment changes, an anchor switch, and four
   citations so you can watch the oldest card retire.

   ```
   python3 hud_bridge.py --demo
   ```

2. Open `hud.html` in a browser. A file URL works:

   ```
   open hud.html
   ```

   The page connects to `ws://127.0.0.1:8765` and starts animating. If the
   bridge is not running yet, a small "Reconnecting" chip shows in the top
   right and the page retries with backoff until the bridge is up.

3. Watch the desk. The speaking anchor's ring pulses with amplitude, the
   question line reads "Now answering:", citation cards slide in on the right,
   and the sentiment bar tints and labels itself.

## Feeding real events

Without `--demo`, the bridge forwards events from two inputs to every connected
HUD:

- stdin, one JSON object per line. Good for scripting and manual tests:

  ```
  python3 hud_bridge.py
  ```

  then type or pipe lines such as:

  ```
  {"type":"speak_start","anchor":"rylee","question":"How many AT&T issues?"}
  {"type":"sentence","anchor":"rylee","text":"The library holds 2,466 records."}
  {"type":"citation","source_id":"x","source_name":"AT&T index","source_url":"https://example.org/att","record_date":2026}
  {"type":"sentiment","value":"negative"}
  {"type":"speak_end","anchor":"rylee"}
  {"type":"idle"}
  ```

- a producer socket. The voice loop on the mini connects to
  `ws://127.0.0.1:8765` and sends the same JSON messages. Anything a producer
  sends is forwarded to the HUD. The HUD only receives, so it never loops.

## The event protocol

One JSON object per message. Unknown types are ignored.

```
{"type":"speak_start","anchor":"rylee"|"co","question": string}
{"type":"amplitude","anchor": string,"value": 0..1}
{"type":"sentence","anchor": string,"text": string}
{"type":"citation","source_id": string,"source_url": string,"record_date": int|null,"source_name": string}
{"type":"sentiment","value":"positive"|"negative"|"neutral"}
{"type":"speak_end","anchor": string}
{"type":"idle"}
```

Notes the HUD enforces:

- The question line only appears when a `speak_start` carries a question.
- The caption only appears when a `sentence` arrives, and clears on
  `speak_end` and `idle`.
- Sentiment shows no claim until a `sentiment` event arrives. The resting bar
  is a neutral gray with no word.
- `record_date` is read flexibly. A plain year like 2026 shows as the year. A
  unix timestamp in seconds or milliseconds shows as an ISO date. `null` shows
  as "Date not recorded".
- Citations stack up to three. A fourth slides the oldest out.

## OBS browser source recipe

1. In OBS, add a Source, choose Browser.
2. Check "Local file" and pick `hud.html` from this directory.
3. Set Width 1920 and Height 1080.
4. Leave "Shutdown source when not visible" unchecked so the socket stays up.
5. Check "Refresh browser when scene becomes active" if you want a clean
   reconnect on scene switches.
6. The page background is transparent, so the HUD composites over your camera
   or desk scene with no extra key.
7. Start `hud_bridge.py` before or after OBS. The HUD reconnects on its own.

## Latency

The citation benchmark is on screen within one second of the claim being
spoken. The path is deliberately short. The producer sends a `citation` event,
the bridge frames it and writes it to the socket in the same call, and the HUD
inserts the card on the next frame. No queue, no batching, no network hop
beyond the local socket.

## Running the checks

```
python3 -m py_compile hud_bridge.py
node check.js
```

`check.js` asserts the disclosure string, the WebSocket URL, the absence of any
external http or https resource reference in the HUD, the presence of the
citation panel and the three sentiment words, and that no file contains an em
dash.
