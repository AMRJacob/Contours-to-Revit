#!/usr/bin/env python3
"""Build the app's compact site-context tiles from an osmium GeoJSON-sequence export.

Usage: build_data.py <input.geojsonseq> <out_dir> <source_date>

Keeps: parking lots (polygons), street surface areas (area:highway / highway+area=yes polygons),
sidewalks (footway=sidewalk lines). Writes gzip-compressed tiles of TILE degrees named "<tx>_<ty>.bin"
plus "i.bin" (index: build/source dates, tile size, data extent).

Tile payload (before gzip), JSON:
  {"p": [[id, type, rings], ...], "s": [[id, kind, rings], ...], "w": [[id, line], ...]}
Coordinates are integers (degrees * 1e6), delta-encoded along each ring/line.
"""
import gzip
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone

TILE = 0.02  # degrees (~2.2 km north-south)
SCALE = 1_000_000


def enc(coords):
    out, px, py = [], 0, 0
    for x, y in coords:
        ix, iy = round(x * SCALE), round(y * SCALE)
        out += [ix - px, iy - py]
        px, py = ix, iy
    return out


def rings_of(geom):
    t = geom.get("type")
    if t == "Polygon":
        return geom["coordinates"]
    if t == "MultiPolygon":
        return [r for poly in geom["coordinates"] for r in poly]
    return []


def main():
    src, out_dir, source_date = sys.argv[1], sys.argv[2], sys.argv[3]
    tiles = defaultdict(lambda: {"p": [], "s": [], "w": []})
    ext = [180, 90, -180, -90]
    counts = {"p": 0, "s": 0, "w": 0}
    with open(src, encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip().lstrip("\x1e")
            if not raw:
                continue
            f = json.loads(raw)
            props, geom = f.get("properties") or {}, f.get("geometry") or {}
            fid = str(props.get("@id", ""))
            if props.get("amenity") == "parking":
                key, rings = "p", rings_of(geom)
                rec = lambda r: [fid, props.get("parking", ""), r]
            elif props.get("area:highway") or (props.get("highway") and props.get("area") == "yes"):
                key, rings = "s", rings_of(geom)
                rec = lambda r: [fid, props.get("area:highway") or props.get("highway"), r]
            elif props.get("footway") == "sidewalk" and geom.get("type") == "LineString":
                key, rings = "w", [geom["coordinates"]]
                rec = None
            else:
                continue
            if not rings:
                continue
            pts = [c for r in rings for c in r]
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            ext = [min(ext[0], min(xs)), min(ext[1], min(ys)), max(ext[2], max(xs)), max(ext[3], max(ys))]
            item = [fid, enc(rings[0])] if key == "w" else rec([enc(r) for r in rings])
            counts[key] += 1
            for tx in range(math.floor(min(xs) / TILE), math.floor(max(xs) / TILE) + 1):
                for ty in range(math.floor(min(ys) / TILE), math.floor(max(ys) / TILE) + 1):
                    tiles[(tx, ty)][key].append(item)

    import os
    os.makedirs(out_dir, exist_ok=True)
    total = 0
    for (tx, ty), payload in tiles.items():
        data = gzip.compress(json.dumps(payload, separators=(",", ":")).encode(), 9)
        total += len(data)
        with open(os.path.join(out_dir, f"{tx}_{ty}.bin"), "wb") as fh:
            fh.write(data)
    index = {
        "v": 1, "tile": TILE, "scale": SCALE, "ext": [round(v, 5) for v in ext],
        "src": source_date, "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "n": counts, "tiles": len(tiles),
    }
    with open(os.path.join(out_dir, "i.bin"), "wb") as fh:
        fh.write(gzip.compress(json.dumps(index, separators=(",", ":")).encode(), 9))
    print(f"{len(tiles)} tiles, {total / 1e6:.2f} MB compressed; counts {counts}; extent {index['ext']}")


if __name__ == "__main__":
    main()
