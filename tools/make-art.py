#!/usr/bin/env python3
"""Background line art for the four task tabs (Existing site, Site design, Sketch, Diagram).

Writes img/art-<mode>.svg: black strokes on transparent, 400 × 900. The app uses them as CSS masks filled with the
tab's colour, so one drawing works in light and dark themes. Run: python3 tools/make-art.py
"""
import math
import random
from pathlib import Path

import numpy as np
from skimage.measure import find_contours

W, H = 400, 900
OUT = Path(__file__).resolve().parent.parent / 'img'
OUT.mkdir(exist_ok=True)


def svg(name, body):
    s = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" fill="none" '
         f'stroke="#000" stroke-linecap="round" stroke-linejoin="round">{body}</svg>')
    (OUT / f'art-{name}.svg').write_text(s)
    print(name, len(s) // 1024, 'KB')


def path(pts, close=False, **a):
    if len(pts) < 2:
        return ''
    d = 'M' + ' L'.join(f'{x:.1f},{y:.1f}' for x, y in pts) + (' Z' if close else '')
    attrs = ' '.join(f'{k.replace("_", "-")}="{v}"' for k, v in a.items())
    return f'<path d="{d}" {attrs}/>'


def chaikin(P, n=2, closed=False):
    for _ in range(n):
        Q = []
        rng = range(len(P)) if closed else range(len(P) - 1)
        for i in rng:
            a, b = P[i], P[(i + 1) % len(P)]
            Q += [(0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]), (0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1])]
        if not closed:
            Q = [P[0]] + Q + [P[-1]]
        P = Q
    return P


def simplify(P, step=2.0):
    out = [P[0]]
    for p in P[1:]:
        if math.dist(p, out[-1]) >= step:
            out.append(p)
    if out[-1] != P[-1]:
        out.append(P[-1])
    return out


def heightfield(seed, nx=100, ny=225, bumps=14):
    rnd = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:ny, 0:nx] / np.array([ny, nx])[:, None, None] * np.array([H, W])[:, None, None]
    Z = 0.25 * yy / H
    for _ in range(bumps):
        cx, cy = rnd.uniform(-40, W + 40), rnd.uniform(H * 0.25, H + 60)
        r, h = rnd.uniform(60, 190), rnd.uniform(-0.35, 0.6)
        Z += h * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r))
    return Z, W / (nx - 1), H / (ny - 1)


def contours(Z, sx, sy, levels):
    out = []
    for i, lv in enumerate(levels):
        for c in find_contours(Z, lv):
            P = [(p[1] * sx, p[0] * sy) for p in c]
            if len(P) < 4:
                continue
            closed = math.dist(P[0], P[-1]) < 1e-6
            out.append((i, chaikin(simplify(P, 5), 2, closed), closed))
    return out


def jitter(P, a, rnd):
    return [(x + rnd.uniform(-a, a), y + rnd.uniform(-a, a)) for x, y in P]


# ---------------------------------------------------------------- Existing site: a survey sheet
def existing():
    Z, sx, sy = heightfield(7)
    lv = np.linspace(Z.min(), Z.max(), 34)[1:-1]
    b = []
    for i, P, cl in contours(Z, sx, sy, lv):
        major = i % 5 == 0
        b.append(path(P, cl, stroke_width=1.6 if major else 0.7, opacity=0.9 if major else 0.55))
    # survey grid ticks and coordinates
    for x in range(0, W + 1, 50):
        b.append(path([(x, 0), (x, H)], stroke_width=0.35, opacity=0.25, stroke_dasharray='2 6'))
    for y in range(0, H + 1, 50):
        b.append(path([(0, y), (W, y)], stroke_width=0.35, opacity=0.25, stroke_dasharray='2 6'))
        if y % 100 == 0:
            b.append(f'<text x="6" y="{y - 3}" font-family="monospace" font-size="7" fill="#000" stroke="none" opacity=".45">N {y * 10:05d}</text>')
    # traverse with stations
    rnd = random.Random(3)
    T = [(70, 820), (150, 700), (285, 742), (330, 600), (210, 520), (95, 590)]
    b.append(path(T, True, stroke_width=1, stroke_dasharray='9 4 2 4', opacity=0.8))
    for k, (x, y) in enumerate(T):
        b.append(path([(x, y - 7), (x + 6, y + 4), (x - 6, y + 4)], True, stroke_width=1.2))
        b.append(f'<text x="{x + 9}" y="{y - 6}" font-family="monospace" font-size="8" fill="#000" stroke="none" opacity=".7">CP-{k + 1}</text>')
    # benchmark and north arrow
    b.append('<circle cx="250" cy="830" r="7" stroke-width="1.2"/><path d="M243 830h14M250 823v14" stroke-width="1"/>')
    b.append('<text x="262" y="834" font-family="monospace" font-size="8" fill="#000" stroke="none">BM 287.42</text>')
    b.append('<g transform="translate(350 470)"><circle r="18" stroke-width="1"/><path d="M0 -26 L6 6 L0 2 L-6 6 Z" fill="#000" stroke-width="0.8"/><text x="-4" y="-30" font-family="sans-serif" font-size="11" fill="#000" stroke="none" font-weight="700">N</text></g>')
    svg('existing', ''.join(b))


# ---------------------------------------------------------------- Site design: a grading section and plan
def design():
    rnd = random.Random(11)
    b = []
    # plan contours bending around a pad (top half fades out anyway)
    Z, sx, sy = heightfield(21, bumps=10)
    yy, xx = np.mgrid[0:Z.shape[0], 0:Z.shape[1]] * np.array([sy, sx])[:, None, None]
    pad = (np.abs(xx - 215) < 85) & (np.abs(yy - 520) < 55)
    Z = np.where(pad, Z[pad].mean(), Z)
    for _ in range(2):
        Z = (Z + np.roll(Z, 1, 0) + np.roll(Z, -1, 0) + np.roll(Z, 1, 1) + np.roll(Z, -1, 1)) / 5
    lv = np.linspace(Z.min(), Z.max(), 26)[1:-1]
    b.append('<clipPath id="pl"><rect width="400" height="690"/></clipPath><g clip-path="url(#pl)">')
    for i, P, cl in contours(Z, sx, sy, lv):
        b.append(path(P, cl, stroke_width=1.3 if i % 5 == 0 else 0.6, opacity=0.6, stroke_dasharray='' if i % 2 else '5 3'))
    b.append('</g>')
    b.append(path([(130, 465), (300, 465), (300, 575), (130, 575)], True, stroke_width=1.8))
    b.append('<text x="160" y="525" font-family="monospace" font-size="10" fill="#000" stroke="none">PAD FFE 312.00</text>')
    # section: existing ground (dashed), proposed (solid), cut/fill hatching, wall, stakes
    base = 790
    xs = np.linspace(0, W, 81)
    ex = base - 30 * np.sin(xs / 70) - 20 * np.cos(xs / 37) - xs * 0.05
    pr = np.where((xs > 110) & (xs < 310), base - 20, ex)
    pr = np.where((xs >= 80) & (xs <= 110), ex + (base - 20 - ex) * (xs - 80) / 30, pr)
    pr = np.where((xs >= 310) & (xs <= 345), base - 20 + (ex - base + 20) * (xs - 310) / 35, pr)
    b.append(path(list(zip(xs, ex)), stroke_width=1.1, stroke_dasharray='6 4'))
    b.append(path(list(zip(xs, pr)), stroke_width=2))
    for x in np.arange(4, W, 7):
        e, p = np.interp(x, xs, ex), np.interp(x, xs, pr)
        if abs(e - p) > 2:
            lo, hi = min(e, p), max(e, p)
            b.append(path([(x, lo + 1), (x - (hi - lo) * 0.4, hi - 1)] if e < p else [(x, lo + 1), (x + (hi - lo) * 0.4, hi - 1)], stroke_width=0.5, opacity=0.6))
    b.append(path([(305, base - 60), (311, base - 60), (311, base + 5), (305, base + 5)], True, stroke_width=1.4))
    for x in (60, 120, 200, 290, 360):
        y = np.interp(x, xs, pr)
        b.append(path([(x, y), (x, y - 26)], stroke_width=1.1))
        b.append(path([(x, y - 26), (x + 12, y - 22), (x, y - 18)], True, stroke_width=0.9))
    for k in range(6):
        y = base + 20 + k * 14
        b.append(path(list(zip(xs, [y + 4 * math.sin(x / (30 + k * 7) + k) for x in xs])), stroke_width=0.45, opacity=0.5))
    b.append(path([(110, base + 110), (310, base + 110)], stroke_width=0.8))
    b.append(path([(110, base + 104), (110, base + 116)], stroke_width=0.8))
    b.append(path([(310, base + 104), (310, base + 116)], stroke_width=0.8))
    b.append(f'<text x="182" y="{base + 106}" font-family="monospace" font-size="8" fill="#000" stroke="none">2.0% MIN</text>')
    svg('design', ''.join(b))


# ---------------------------------------------------------------- Sketch: axonometric massing study
def sketch():
    rnd = random.Random(5)
    b = []
    a = math.radians(30)

    def iso(x, y, z):  # plan x/y, height z → screen
        return (200 + (x - y) * math.cos(a), 640 + (x + y) * math.sin(a) - z)

    def line(p, q, w=1.0, op=1.0, over=7):
        P, Q = iso(*p), iso(*q)
        d = math.dist(P, Q) or 1
        u = ((Q[0] - P[0]) / d, (Q[1] - P[1]) / d)
        P2 = (P[0] - u[0] * rnd.uniform(0, over), P[1] - u[1] * rnd.uniform(0, over))
        Q2 = (Q[0] + u[0] * rnd.uniform(0, over), Q[1] + u[1] * rnd.uniform(0, over))
        b.append(path(jitter([P2, Q2], 0.6, rnd), stroke_width=w, opacity=op))

    def box(x, y, w, d, h, floors=0):
        c = [(x, y), (x + w, y), (x + w, y + d), (x, y + d)]
        for i in range(4):
            line((*c[i], 0), (*c[(i + 1) % 4], 0), 0.6, 0.5)
            line((*c[i], h), (*c[(i + 1) % 4], h), 1.3)
            line((*c[i], 0), (*c[i], h), 1.1 if i != 0 else 0.6, 1 if i != 0 else 0.4)
        for f in range(1, floors):
            z = h * f / floors
            for i in (1, 2):
                line((*c[i], z), (*c[(i + 1) % 4], z), 0.4, 0.55, 2)
    # site grid
    for g in range(-200, 260, 40):
        line((g, -200, 0), (g, 240, 0), 0.3, 0.3, 0)
        line((-200, g, 0), (240, g, 0), 0.3, 0.3, 0)
    box(-150, -60, 90, 120, 60, 5)
    box(-40, -120, 70, 70, 190, 16)
    box(-40, -50, 140, 70, 36, 3)
    box(60, 40, 80, 120, 84, 7)
    box(-150, 90, 120, 60, 24, 2)
    # sloped roof and push/pull arrow
    line((60, 40, 84), (100, 40, 108), 1.2)
    line((140, 40, 84), (100, 40, 108), 1.2)
    P = iso(-5, -85, 210)
    b.append(path([(P[0], P[1] + 12), (P[0], P[1] - 40)], stroke_width=1.6))
    b.append(path([(P[0] - 7, P[1] - 30), (P[0], P[1] - 42), (P[0] + 7, P[1] - 30)], stroke_width=1.6))
    # trees and people for scale
    for _ in range(14):
        x, y = rnd.uniform(-190, 220), rnd.uniform(-190, 220)
        if -160 < x < 150 and -130 < y < 160:
            continue
        X, Y = iso(x, y, 0)
        r = rnd.uniform(7, 13)
        b.append(f'<circle cx="{X:.1f}" cy="{Y - r:.1f}" r="{r:.1f}" stroke-width="0.8" opacity=".7"/>')
        b.append(path([(X, Y), (X, Y - r * 0.4)], stroke_width=0.8, opacity=0.7))
    # sketchy hatching on a few faces
    for k in range(10):
        z = 190 - k * 8
        p, q = iso(30, -120, z), iso(30, -50, z - 30)
        b.append(path([p, q], stroke_width=0.4, opacity=0.5))
    svg('sketch', ''.join(b))


# ---------------------------------------------------------------- Diagram: site analysis diagram
def diagram():
    rnd = random.Random(9)
    b = []
    # site boundary (dash-dot) and parcel
    B = [(40, 430), (360, 410), (375, 840), (30, 860)]
    b.append(path(B, True, stroke_width=1.4, stroke_dasharray='14 4 3 4'))
    # zones as soft blobs (dashed)
    for cx, cy, r in [(130, 560, 70), (265, 650, 85), (120, 760, 55)]:
        P = [(cx + r * (1 + 0.12 * math.sin(3 * t + cx)) * math.cos(t), cy + r * 0.8 * (1 + 0.1 * math.cos(2 * t + cy)) * math.sin(t)) for t in np.linspace(0, 2 * math.pi, 60)]
        b.append(path(P, True, stroke_width=1.1, stroke_dasharray='4 4'))
        for k in range(-r, r, 9):
            b.append(path([(cx + k - 20, cy + 25), (cx + k + 20, cy - 25)], stroke_width=0.35, opacity=0.35))
    # circulation arrows (curved)
    def arrow(P, w=2.4):
        P = chaikin(P, 3)
        b.append(path(P, stroke_width=w))
        (x1, y1), (x2, y2) = P[-2], P[-1]
        ang = math.atan2(y2 - y1, x2 - x1)
        h = 11
        b.append(path([(x2 - h * math.cos(ang - 0.45), y2 - h * math.sin(ang - 0.45)), (x2, y2), (x2 - h * math.cos(ang + 0.45), y2 - h * math.sin(ang + 0.45))], stroke_width=w))
    arrow([(10, 880), (90, 820), (150, 690), (230, 600)])
    arrow([(395, 520), (330, 560), (300, 600)], 1.6)
    arrow([(200, 895), (205, 820), (190, 760)], 1.6)
    # wind arrows (dashed, parallel)
    for k in range(4):
        y = 300 + k * 26
        P = [(20 + k * 10, y), (120, y - 12), (220, y + 4), (320, y - 8)]
        P = chaikin(P, 3)
        b.append(path(P, stroke_width=0.9, stroke_dasharray='10 5', opacity=0.7))
        (x1, y1), (x2, y2) = P[-2], P[-1]
        ang = math.atan2(y2 - y1, x2 - x1)
        b.append(path([(x2 - 8 * math.cos(ang - 0.5), y2 - 8 * math.sin(ang - 0.5)), (x2, y2), (x2 - 8 * math.cos(ang + 0.5), y2 - 8 * math.sin(ang + 0.5))], stroke_width=0.9))
    # sun path arc with sun symbols
    cx, cy, R = 200, 400, 170
    arc = [(cx + R * math.cos(t), cy - 0.55 * R * math.sin(t)) for t in np.linspace(math.radians(160), math.radians(20), 50)]
    b.append(path(arc, stroke_width=1, stroke_dasharray='2 5'))
    for t in (150, 115, 90, 65, 30):
        x, y = cx + R * math.cos(math.radians(t)), cy - 0.55 * R * math.sin(math.radians(t))
        b.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6" stroke-width="1.1"/>')
        for k in range(8):
            u = k * math.pi / 4
            b.append(path([(x + 9 * math.cos(u), y + 9 * math.sin(u)), (x + 13 * math.cos(u), y + 13 * math.sin(u))], stroke_width=0.8))
    # labels and north arrow
    for x, y, t in [(95, 565, 'ARRIVAL'), (230, 655, 'BUILDING'), (95, 765, 'PARKING'), (30, 400, 'PREVAILING WIND'), (150, 230, 'SUMMER SUN')]:
        b.append(f'<text x="{x}" y="{y}" font-family="sans-serif" font-size="9" letter-spacing="2" fill="#000" stroke="none" font-weight="700">{t}</text>')
    b.append('<g transform="translate(345 860)"><path d="M0 -22 L7 8 L0 3 L-7 8 Z" fill="#000" stroke-width="0.8"/><text x="-4" y="-26" font-family="sans-serif" font-size="11" fill="#000" stroke="none" font-weight="700">N</text></g>')
    svg('diagram', ''.join(b))


existing()
design()
sketch()
diagram()
