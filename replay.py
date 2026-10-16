"""Replay the game commands recorded in a bridge -v log into a bridge on another port.

Usage:
  ./vacuglide-bridge -dry -addr 127.0.0.1:12398 &
  python3 replay.py testdata/cockhero-alternating.log
Commands are spaced by each LinearCmd's Duration, which matched the real game timing.
"""
import asyncio, json, re, sys

import websockets

URL = "ws://127.0.0.1:12398"


async def main(path):
    text = open(path).read()
    msgs = [m for _, b in re.findall(r'^(\d\d:\d\d:\d\d) <- (\[.*?^\])', text, re.S | re.M)
            for m in json.loads(b) if "LinearCmd" in m or "ScalarCmd" in m]
    async with websockets.connect(URL) as ws:
        async def send(m):
            await ws.send(json.dumps([m]))
            await ws.recv()
        await send({"RequestServerInfo": {"Id": 1, "ClientName": "replay", "MessageVersion": 3}})
        for m in msgs:
            await send(m)
            if "LinearCmd" in m:
                await asyncio.sleep(m["LinearCmd"]["Vectors"][0]["Duration"] / 1000)
        await asyncio.sleep(2)


asyncio.run(main(sys.argv[1]))
