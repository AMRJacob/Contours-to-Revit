#!/usr/bin/env python3
"""Line-art banners behind each menu title (Legend style): a simple picture of what that menu does.

Drawn as white strokes on transparent SVG; the CSS uses them as a mask so they take the task colour.
Usage: python3 tools/make-banners.py  → img/banner-*.svg
"""
import math, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'img')
W, H = 260, 64


def svg(body, sw=1.6):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
            f'<g fill="none" stroke="#fff" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round">{body}</g></svg>')


def path(pts, close=False, extra=''):
    d = 'M' + ' L'.join(f'{x:.1f},{y:.1f}' for x, y in pts) + (' Z' if close else '')
    return f'<path d="{d}" {extra}/>'


def hill(x0, x1, base, top, n=60, ph=0.0, amp=1.0):
    return [(x0 + (x1 - x0) * i / n, base - (top * amp) * (math.sin(math.pi * i / n) ** 1.6) * (1 + 0.12 * math.sin(i / n * 9 + ph))) for i in range(n + 1)]


B = {}

# Site: parcels seen from above, a dashed boundary with corner handles, a pin.
b = ''
for x in range(110, 260, 26):
    b += f'<path d="M{x},6 L{x - 8},60" opacity=".35"/>'
for y in (16, 34, 52):
    b += f'<path d="M100,{y} L258,{y - 6}" opacity=".35"/>'
b += '<path d="M138,14 L224,8 L232,48 L146,56 Z" stroke-dasharray="5 4" stroke-width="2"/>'
for x, y in ((138, 14), (224, 8), (232, 48), (146, 56)):
    b += f'<rect x="{x - 3}" y="{y - 3}" width="6" height="6" fill="#fff"/>'
b += '<path d="M186,36 c-7,-9 -7,-18 0,-18 c7,0 7,9 0,18 Z" stroke-width="1.8"/><circle cx="186" cy="24" r="2.4" fill="#fff"/>'
B['site'] = svg(b)

# Topography: contour rings in plan beside a profile of the same hill.
b = path(hill(100, 170, 58, 34), extra='stroke-width="1.8"')
for k in range(1, 4):
    yk = 58 - 34 * k / 4
    b += f'<path d="M100,{yk:.1f} L172,{yk:.1f}" opacity=".3" stroke-dasharray="2 3"/>'
for k, rr in enumerate((27, 20, 13, 6)):
    pts = [(214 + rr * 1.55 * math.cos(t) * (1 + 0.1 * math.sin(3 * t + k)), 33 + rr * math.sin(t) * (1 + 0.08 * math.cos(2 * t + k))) for t in [i / 48 * 2 * math.pi for i in range(48)]]
    b += path(pts, close=True, extra=f'opacity="{0.5 + 0.15 * k}"' + (' stroke-width="2"' if k == 0 else ''))
B['topo'] = svg(b)

# Place in Revit: an origin crosshair, X/Y axes, north arrow and a small building.
b = '<circle cx="150" cy="38" r="9"/><path d="M150,22 L150,54 M134,38 L166,38"/>'
b += '<path d="M150,38 L214,38 M208,34 L214,38 L208,42" stroke-width="1.8"/><path d="M150,38 L150,8 M146,14 L150,8 L154,14" stroke-width="1.8"/>'
b += '<text x="218" y="42" fill="#fff" stroke="none" font-family="Georgia,serif" font-size="11">X</text><text x="156" y="12" fill="#fff" stroke="none" font-family="Georgia,serif" font-size="11">Y</text>'
b += '<path d="M178,50 L178,20 L202,14 L226,20 L226,50 Z M190,50 L190,38 L198,38 L198,50" opacity=".6"/>'
b += '<path d="M244,12 L238,28 L244,24 L250,28 Z" fill="#fff"/><text x="240.5" y="40" fill="#fff" stroke="none" font-family="Georgia,serif" font-size="10">N</text>'
B['revit'] = svg(b)

# Export: stacked sheets with a download arrow, CSV / DXF / PNG tags.
b = ''
for i, (lab, x) in enumerate((('CSV', 132), ('DXF', 168), ('PNG', 204))):
    y = 10 + i * 2
    b += f'<path d="M{x},{y} L{x + 26},{y} L{x + 32},{y + 6} L{x + 32},{y + 42} L{x},{y + 42} Z M{x + 26},{y} L{x + 26},{y + 6} L{x + 32},{y + 6}"/>'
    b += f'<text x="{x + 5}" y="{y + 28}" fill="#fff" stroke="none" font-family="Georgia,serif" font-size="9">{lab}</text>'
b += '<path d="M248,10 L248,44 M240,36 L248,44 L256,36 M236,54 L256,54" stroke-width="2"/>'
B['export'] = svg(b)

# Grading: a sloped section cut into flat pads, a level and a survey stake.
b = path([(96, 58), (140, 58), (150, 46), (190, 46), (200, 34), (240, 34), (258, 26)], extra='stroke-width="2"')
b += path([(96, 58), (258, 22)], extra='stroke-dasharray="3 4" opacity=".5"')
b += '<path d="M170,46 L170,20 M164,20 L176,20 L170,28 Z" /><path d="M222,34 L222,12 L232,15 L222,18" />'
b += '<rect x="112" y="42" width="22" height="8" rx="2"/><circle cx="123" cy="46" r="2"/>'
B['grading'] = svg(b)

# Earthwork: ground line, cut (hatched above the new grade) and fill (dotted below).
b = path([(96, 40), (140, 28), (180, 22), (220, 34), (258, 48)], extra='stroke-width="2"')
b += path([(96, 40), (258, 36)], extra='stroke-dasharray="6 3"')
for x in range(132, 200, 7):
    b += f'<path d="M{x},38 L{x + 7},26" opacity=".55"/>'
for x in range(226, 256, 5):
    for y in (38, 43):
        b += f'<circle cx="{x}" cy="{y}" r=".9" fill="#fff" stroke="none"/>'
b += '<text x="152" y="54" fill="#fff" stroke="none" font-family="Georgia,serif" font-size="10">cut</text><text x="236" y="60" fill="#fff" stroke="none" font-family="Georgia,serif" font-size="10">fill</text>'
B['earth'] = svg(b)

# Features: a retaining wall, steps, a path and a tree.
b = '<path d="M100,56 L100,30 L114,30 L114,56"/><path d="M100,36 L114,36 M100,43 L114,43 M100,50 L114,50" opacity=".5"/>'
b += path([(120, 56), (120, 48), (132, 48), (132, 40), (144, 40), (144, 32), (156, 32)], extra='stroke-width="1.8"')
b += '<path d="M170,58 C190,48 205,50 222,40 S248,30 258,26" stroke-dasharray="1 5" stroke-width="2.4"/>'
b += '<path d="M236,58 L236,40"/><circle cx="236" cy="28" r="12"/><circle cx="230" cy="24" r="5" opacity=".5"/>'
B['features'] = svg(b)

# Save: a folder with a project sheet going in.
b = '<path d="M150,22 L170,22 L176,28 L226,28 L226,58 L150,58 Z"/><path d="M184,6 L210,6 L210,40 L184,40 Z" opacity=".7"/>'
b += '<path d="M197,12 L197,32 M191,26 L197,32 L203,26" stroke-width="1.8"/>'
B['save'] = svg(b)

# Sketch: massing blocks in isometric.
def box(x, y, w, d, h):
    a = (x, y); bpt = (x + w, y + w * 0.5); c = (x + w - d, y + w * 0.5 + d * 0.5); e = (x - d, y + d * 0.5)
    up = lambda p: (p[0], p[1] - h)
    s = path([e, a, bpt, c], close=True, extra='opacity=".45"')
    s += path([up(e), up(a), up(bpt), up(c)], close=True)
    s += path([e, up(e)]) + path([c, up(c)]) + path([bpt, up(bpt)])
    return s
b = box(150, 34, 26, 20, 22) + box(196, 26, 22, 16, 18) + box(232, 30, 18, 14, 10)
B['sketch'] = svg(b)

# Diagram: a sweeping arrow, a region and a label bubble.
b = '<path d="M104,52 C140,20 180,18 222,30" stroke-width="2.6"/><path d="M214,22 L224,31 L211,36" stroke-width="2.6"/>'
b += '<path d="M168,42 L196,38 L204,52 L172,58 Z" opacity=".55" stroke-dasharray="4 3"/>'
b += '<path d="M226,6 L256,6 L256,20 L240,20 L234,26 L234,20 L226,20 Z"/>'
B['diagram'] = svg(b)

for k, v in B.items():
    with open(os.path.join(OUT, f'banner-{k}.svg'), 'w') as f:
        f.write(v)
print('wrote', ', '.join(B))
