#!/usr/bin/env python3
"""Rylee HUD bridge.

A tiny WebSocket server that stands between the producer (the voice loop on the
mini) and the HUD (an OBS browser source). It forwards JSON events, one per
message, to every connected HUD client.

Design goals:
  - Python standard library only. No pip install. No build step.
  - One process, low latency. A citation must reach the HUD within one second
    of the claim being spoken, so forwarding is synchronous and cheap.
  - Accepts events from three places, all treated the same way:
      1. any connected producer socket that sends JSON,
      2. stdin, one JSON object per line,
      3. the built in --demo replay.
    Whatever arrives is broadcast to every other connected client.

The HUD only receives, so it never causes a forwarding loop.

No em dashes appear anywhere in this file, in code or in comments or in data.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import struct
import sys
import threading
from typing import Optional

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# All live client connections. Each entry is an asyncio.StreamWriter.
CLIENTS = set()
CLIENTS_LOCK = threading.Lock()


# --------------------------------------------------------------------------- #
# WebSocket framing helpers. RFC 6455, the small subset a JSON relay needs.    #
# --------------------------------------------------------------------------- #

def _accept_key(client_key: str) -> str:
    digest = hashlib.sha1((client_key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


async def _read_http_headers(reader: asyncio.StreamReader) -> dict:
    """Read request headers up to the blank line. Returns a lowercase map."""
    headers = {}
    # request line
    line = await reader.readline()
    if not line:
        return headers
    while True:
        line = await reader.readline()
        if not line or line in (b"\r\n", b"\n"):
            break
        try:
            name, _, value = line.decode("iso-8859-1").partition(":")
        except Exception:
            continue
        headers[name.strip().lower()] = value.strip()
    return headers


async def _handshake(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> bool:
    headers = await _read_http_headers(reader)
    key = headers.get("sec-websocket-key")
    if not key or "websocket" not in headers.get("upgrade", "").lower():
        try:
            writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            await writer.drain()
        except Exception:
            pass
        return False
    accept = _accept_key(key)
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
    )
    writer.write(response.encode("ascii"))
    await writer.drain()
    return True


def _encode_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    """Server to client frame. Never masked. Single frame."""
    header = bytearray()
    header.append(0x80 | (opcode & 0x0F))  # FIN set
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < (1 << 16):
        header.append(126)
        header += struct.pack(">H", length)
    else:
        header.append(127)
        header += struct.pack(">Q", length)
    return bytes(header) + payload


async def _read_frame(reader: asyncio.StreamReader):
    """Read one client frame. Returns (opcode, bytes) or None at end of stream."""
    first = await reader.readexactly(1)
    b0 = first[0]
    opcode = b0 & 0x0F
    second = await reader.readexactly(1)
    b1 = second[0]
    masked = (b1 & 0x80) != 0
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack(">H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", await reader.readexactly(8))[0]
    mask = await reader.readexactly(4) if masked else b"\x00\x00\x00\x00"
    data = await reader.readexactly(length) if length else b""
    if masked:
        data = bytes(data[i] ^ mask[i % 4] for i in range(len(data)))
    return opcode, data


# --------------------------------------------------------------------------- #
# Broadcast.                                                                    #
# --------------------------------------------------------------------------- #

def _broadcast_sync(text: str) -> None:
    """Frame the text once and write it to every client. Safe from any thread
    because StreamWriter.write buffers without awaiting."""
    frame = _encode_frame(text.encode("utf-8"))
    with CLIENTS_LOCK:
        dead = []
        for w in CLIENTS:
            try:
                w.write(frame)
            except Exception:
                dead.append(w)
        for w in dead:
            CLIENTS.discard(w)


def broadcast_event(obj: dict) -> None:
    _broadcast_sync(json.dumps(obj, separators=(",", ":")))


# --------------------------------------------------------------------------- #
# Connection handler.                                                          #
# --------------------------------------------------------------------------- #

async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    peer = writer.get_extra_info("peername")
    ok = await _handshake(reader, writer)
    if not ok:
        writer.close()
        return
    with CLIENTS_LOCK:
        CLIENTS.add(writer)
    sys.stderr.write("client connected: %s (total %d)\n" % (peer, len(CLIENTS)))
    sys.stderr.flush()
    try:
        while True:
            try:
                frame = await _read_frame(reader)
            except (asyncio.IncompleteReadError, ConnectionResetError):
                break
            if frame is None:
                break
            opcode, data = frame
            if opcode == 0x8:  # close
                break
            if opcode == 0x9:  # ping, reply pong
                writer.write(_encode_frame(data, opcode=0xA))
                await writer.drain()
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode in (0x1, 0x2):  # text or binary carrying JSON
                _forward_incoming(data, writer)
    finally:
        with CLIENTS_LOCK:
            CLIENTS.discard(writer)
        try:
            writer.close()
        except Exception:
            pass
        sys.stderr.write("client gone: %s (total %d)\n" % (peer, len(CLIENTS)))
        sys.stderr.flush()


def _forward_incoming(data: bytes, sender: asyncio.StreamWriter) -> None:
    """A producer socket sent us something. Parse and rebroadcast to others."""
    try:
        text = data.decode("utf-8")
    except Exception:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        # forward to everyone except the sender
        frame = _encode_frame(json.dumps(obj, separators=(",", ":")).encode("utf-8"))
        with CLIENTS_LOCK:
            for w in CLIENTS:
                if w is sender:
                    continue
                try:
                    w.write(frame)
                except Exception:
                    pass


# --------------------------------------------------------------------------- #
# stdin reader. One JSON object per line, broadcast to clients.                #
# --------------------------------------------------------------------------- #

def _stdin_thread(loop: asyncio.AbstractEventLoop) -> None:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            sys.stderr.write("skipped non JSON stdin line\n")
            sys.stderr.flush()
            continue
        loop.call_soon_threadsafe(broadcast_event, obj)


# --------------------------------------------------------------------------- #
# Demo replay. A canned sixty second script so the HUD can be reviewed with     #
# nothing else running. Illustrative citations, clearly demo only.             #
# --------------------------------------------------------------------------- #

async def _speak_span(anchor: str, seconds: float, peak: float = 0.85) -> None:
    """Emit amplitude events for a speaking span so the ring animates."""
    import math
    steps = max(1, int(seconds / 0.12))
    for i in range(steps):
        t = i / steps
        env = math.sin(t * math.pi)  # rise and fall
        wobble = 0.55 + 0.45 * math.sin(i * 1.7)
        value = max(0.05, peak * env * wobble)
        broadcast_event({"type": "amplitude", "anchor": anchor, "value": round(value, 3)})
        await asyncio.sleep(0.12)


async def run_demo() -> None:
    """Roughly sixty seconds. Question, sentences, two plus citations, sentiment
    changes, an anchor switch. All content is illustrative for HUD review."""
    await asyncio.sleep(1.0)
    broadcast_event({"type": "idle"})
    await asyncio.sleep(1.0)

    # Rylee takes the first question.
    broadcast_event({
        "type": "speak_start", "anchor": "rylee",
        "question": "How many AT&T arbitration issues are in the library?"
    })
    broadcast_event({"type": "sentiment", "value": "neutral"})
    await asyncio.sleep(0.4)

    broadcast_event({"type": "sentence", "anchor": "rylee",
                     "text": "Our library holds 2,466 verified primary AT&T arbitration records."})
    await _speak_span("rylee", 3.2)

    broadcast_event({"type": "citation",
                     "source_id": "att-arb-index-2026",
                     "source_name": "AT&T arbitration record index, Carriers On Notice library",
                     "source_url": "https://www.carriersonnotice.com/library/att/arbitration",
                     "record_date": 2026})
    await asyncio.sleep(0.3)

    broadcast_event({"type": "sentence", "anchor": "rylee",
                     "text": "Each one is corroborated or better before it counts."})
    await _speak_span("rylee", 2.6)

    # Sentiment turns critical as the record shows a clawback pattern.
    broadcast_event({"type": "sentiment", "value": "negative"})
    broadcast_event({"type": "sentence", "anchor": "rylee",
                     "text": "The 2024 terms snapshot added a promotion clawback the prior version did not carry."})
    await _speak_span("rylee", 3.4)

    broadcast_event({"type": "citation",
                     "source_id": "att-terms-2024-diff",
                     "source_name": "AT&T Wireless Customer Agreement, archived 2024 snapshot with diff",
                     "source_url": "https://www.carriersonnotice.com/library/att/terms/2024-diff",
                     "record_date": 1704067200})
    await asyncio.sleep(0.4)

    broadcast_event({"type": "speak_end", "anchor": "rylee"})
    await asyncio.sleep(0.8)

    # The co anchor takes the follow up. Anchor switch.
    broadcast_event({
        "type": "speak_start", "anchor": "co",
        "question": "Has AT&T improved its terms since then?"
    })
    broadcast_event({"type": "sentiment", "value": "positive"})
    await asyncio.sleep(0.3)

    broadcast_event({"type": "sentence", "anchor": "co",
                     "text": "The 2026 revision walked that clawback back for upgrade eligible lines."})
    await _speak_span("co", 3.2)

    broadcast_event({"type": "citation",
                     "source_id": "att-terms-2026-diff",
                     "source_name": "AT&T Wireless Customer Agreement, 2026 revision diff",
                     "source_url": "https://www.carriersonnotice.com/library/att/terms/2026-diff",
                     "record_date": 2026})
    await asyncio.sleep(0.3)

    broadcast_event({"type": "sentence", "anchor": "co",
                     "text": "Credit where the record earns it. The favorable change gets the same prominence as the criticism."})
    await _speak_span("co", 3.8)

    # A fourth citation to show the oldest card retiring off the stack.
    broadcast_event({"type": "citation",
                     "source_id": "ftc-att-2019",
                     "source_name": "FTC action, AT&T data throttling settlement",
                     "source_url": "https://www.ftc.gov/legal-library/browse/cases-proceedings/att-mobility",
                     "record_date": 2019})
    await asyncio.sleep(0.4)

    broadcast_event({"type": "speak_end", "anchor": "co"})
    await asyncio.sleep(1.0)
    broadcast_event({"type": "idle"})

    sys.stderr.write("demo script complete. looping in 4 seconds.\n")
    sys.stderr.flush()
    await asyncio.sleep(4.0)


async def demo_loop() -> None:
    while True:
        try:
            await run_demo()
        except asyncio.CancelledError:
            break


# --------------------------------------------------------------------------- #
# Main.                                                                         #
# --------------------------------------------------------------------------- #

async def main_async(host: str, port: int, demo: bool) -> None:
    server = await asyncio.start_server(handle_client, host, port)
    addr = ", ".join(str(s.getsockname()) for s in server.sockets)
    sys.stderr.write("HUD bridge listening on ws://%s\n" % addr)
    sys.stderr.write("  open hud.html in a browser, it connects to ws://%s:%d\n" % (host, port))
    if demo:
        sys.stderr.write("  demo mode: replaying a canned script on a loop\n")
    else:
        sys.stderr.write("  feed events as JSON lines on stdin, or connect a producer socket\n")
    sys.stderr.flush()

    tasks = []
    if demo:
        tasks.append(asyncio.ensure_future(demo_loop()))
    else:
        loop = asyncio.get_event_loop()
        t = threading.Thread(target=_stdin_thread, args=(loop,), daemon=True)
        t.start()

    async with server:
        await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Rylee HUD WebSocket bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--demo", action="store_true",
                        help="replay a canned sixty second script on a loop")
    args = parser.parse_args()
    try:
        asyncio.run(main_async(args.host, args.port, args.demo))
    except KeyboardInterrupt:
        sys.stderr.write("\nbridge stopped\n")


if __name__ == "__main__":
    main()
