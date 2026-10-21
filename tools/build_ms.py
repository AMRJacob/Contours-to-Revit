#!/usr/bin/env python3
"""Add Microsoft Global ML Building Footprints (with height estimates) to a hosted state's tiles.

Usage: build_ms.py <state_dir> <links.csv>

<state_dir> is a state's folder written by build_data.py (its i.bin gives the extent). Downloads the Microsoft
quadkey files (zoom 9) that overlap the extent, keeps footprints whose first corner is inside it, and writes
gzip'd tiles <state_dir>/m/<tx>_<ty>.bin (same 0.02° grid):
  {"b": [[h, ring], ...]}   h = height in decimetres (-1 = no estimate); ring delta-encoded (degrees * 1e6)
The state's i.bin gains n.m (footprints), n.mh (with heights) and "ms" (newest upload date used).
Source: https://github.com/microsoft/GlobalMLBuildingFootprints (ODbL).
"""
import csv
import gzip
import io
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict

TILE = 0.02
SCALE = 1_000_000


def enc(coords):
    out, px, py = [], 0, 0
    for x, y in coords:
        ix, iy = round(x * SCALE), round(y * SCALE)
        out += [ix - px, iy - py]
        px, py = ix, iy
    return out


def quadkey_bbox(qk):
    x = y = 0
    z = len(qk)
    for i, ch in enumerate(qk):
        mask = 1 << (z - 1 - i)
        d = int(ch)
        if d & 1:
            x |= mask
        if d & 2:
            y |= mask
    n = 2 ** z

    def lat(yy):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))

    return x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)


def fetch(url, tries=3):
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if k == tries - 1:
                raise
            print(f"  retry {url}: {e}", flush=True)


def main():
    state_dir, links_path = sys.argv[1], sys.argv[2]
    idx_path = os.path.join(state_dir, "i.bin")
    idx = json.loads(gzip.decompress(open(idx_path, "rb").read()))
    w, s, e, n = idx["ext"]
    rows = []
    with open(links_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row.get("Location", "").replace(" ", "") != "UnitedStates":
                continue
            bw, bs, be, bn = quadkey_bbox(row["QuadKey"])
            if be < w or bw > e or bn < s or bs > n:
                continue
            rows.append(row)
    print(f"{len(rows)} Microsoft quadkey files overlap {idx['ext']}", flush=True)
    tiles = defaultdict(list)
    count = with_h = 0
    newest = ""
    for row in rows:
        newest = max(newest, row.get("UploadDate", ""))
        data = fetch(row["Url"])
        try:
            data = gzip.decompress(data)
        except OSError:
            pass
        for line in io.TextIOWrapper(io.BytesIO(data), encoding="utf-8"):
            line = line.strip()
            if not line.startswith("{"):
                continue
            f = json.loads(line)
            g = f.get("geometry") or {}
            if g.get("type") == "Polygon":
                ring = g["coordinates"][0]
            elif g.get("type") == "MultiPolygon":
                ring = g["coordinates"][0][0]
            else:
                continue
            if len(ring) < 4:
                continue
            x0, y0 = ring[0]
            if not (w <= x0 <= e and s <= y0 <= n):
                continue
            h = (f.get("properties") or {}).get("height", -1)
            try:
                h = float(h)
            except (TypeError, ValueError):
                h = -1
            hd = round(h * 10) if h > 0 else -1
            count += 1
            if hd > 0:
                with_h += 1
            xs, ys = [p[0] for p in ring], [p[1] for p in ring]
            item = [hd, enc(ring[:-1] if ring[0] == ring[-1] else ring)]
            for tx in range(math.floor(min(xs) / TILE), math.floor(max(xs) / TILE) + 1):
                for ty in range(math.floor(min(ys) / TILE), math.floor(max(ys) / TILE) + 1):
                    tiles[(tx, ty)].append(item)
        print(f"  {row['QuadKey']}: {count} kept so far ({with_h} with heights)", flush=True)
    out = os.path.join(state_dir, "m")
    os.makedirs(out, exist_ok=True)
    total = 0
    for (tx, ty), items in tiles.items():
        blob = gzip.compress(json.dumps({"b": items}, separators=(",", ":")).encode(), 9)
        total += len(blob)
        with open(os.path.join(out, f"{tx}_{ty}.bin"), "wb") as fh:
            fh.write(blob)
    idx.setdefault("n", {})
    idx["n"]["m"], idx["n"]["mh"] = count, with_h
    idx["ms"] = newest[:10]
    with open(idx_path, "wb") as fh:
        fh.write(gzip.compress(json.dumps(idx, separators=(",", ":")).encode(), 9))
    print(f"Microsoft: {count} footprints ({with_h} with heights), {len(tiles)} tiles, {total / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
