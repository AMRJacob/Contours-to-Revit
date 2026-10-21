#!/usr/bin/env python3
"""Combine per-state indexes (<dir>/<state>/i.bin) into the top-level index <dir>/i.bin."""
import gzip
import json
import os
import sys

root = sys.argv[1]
states = []
for name in sorted(os.listdir(root)):
    p = os.path.join(root, name, "i.bin")
    if os.path.isfile(p):
        idx = json.loads(gzip.decompress(open(p, "rb").read()))
        size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(os.path.join(root, name)) for f in fs)
        states.append({"id": name, "ext": idx["ext"], "src": idx["src"], "built": idx["built"], "n": idx["n"], "mb": round(size / 1e6, 2),
                       **({"ms": idx["ms"]} if idx.get("ms") else {})})
top = {"v": 2, "tile": 0.02, "scale": 1_000_000, "states": states}
with open(os.path.join(root, "i.bin"), "wb") as fh:
    fh.write(gzip.compress(json.dumps(top, separators=(",", ":")).encode(), 9))
print(json.dumps(top, indent=1))
