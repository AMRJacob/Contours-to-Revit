#!/usr/bin/env python3
"""Painted key-art backgrounds for the side panel (one per task), made procedurally so they're ours to ship.

Layered ridgelines with atmospheric perspective, a glowing sky, light rays, haze, grain and a vignette — the
mood of a strategy game's menu backdrop. Each task gets its own scene and palette:
  existing  dawn over layered hills, contour lines catching the light
  design    golden-hour terraces and graded pads
  sketch    massing blocks in evening haze
  diagram   twilight, with drafting geometry over the land
Usage: python3 tools/make-keyart.py  → img/key-*.jpg
"""
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

W, H = 900, 1800
OUT = __file__.rsplit('/tools/', 1)[0] + '/img/'


def rng(seed):
    return np.random.default_rng(seed)


def fbm1(r, n, octaves=6, base=4):
    """1-D fractal noise, n samples, about -1..1."""
    out = np.zeros(n)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        k = base * 2 ** o
        pts = r.uniform(-1, 1, k + 3)
        x = np.linspace(0, k, n)
        out += amp * np.interp(x, np.arange(k + 3), pts)
        tot += amp
        amp *= 0.5
    return out / tot


def fbm2(r, h, w, octaves=6, base=3):
    out = np.zeros((h, w))
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        k = base * 2 ** o
        g = r.uniform(-1, 1, (k + 2, k + 2))
        z = fit(g, h, w)
        out += amp * z
        tot += amp
        amp *= 0.5
    return out / tot


def fit(a, h, w):
    """Smoothly resize a small array to exactly h × w."""
    z = ndimage.zoom(a, ((h + 2) / a.shape[0], (w + 2) / a.shape[1]), order=3)
    return z[:h, :w]


def hexc(s):
    s = s.lstrip('#')
    return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], float) / 255


def lerp(a, b, t):
    return a + (b - a) * t


def sky(pal, r, sun):
    y = np.linspace(0, 1, H)[:, None, None]
    top, mid, low = hexc(pal['top']), hexc(pal['mid']), hexc(pal['low'])
    t1 = np.clip(y / 0.42, 0, 1)
    img = np.where(y < 0.42, lerp(top, mid, t1), lerp(mid, low, np.clip((y - 0.42) / 0.3, 0, 1)))
    img = np.broadcast_to(img, (H, W, 3)).copy()
    # Sun glow.
    yy, xx = np.mgrid[0:H, 0:W]
    d = np.hypot((xx - sun[0]) / W, (yy - sun[1]) / W)
    glow = hexc(pal['sun'])
    img += glow * (np.exp(-(d / 0.06) ** 2) * 0.9 + np.exp(-(d / 0.28) ** 2) * 0.35)[..., None]
    # Cloud streaks: stretched noise, lit toward the sun.
    c = fbm2(r, H // 6, W // 2, 5, 2)
    c = fit(c, H, W)
    band = np.exp(-((yy / H - 0.26) / 0.16) ** 2)
    cl = np.clip(c * 1.6 + 0.1, 0, 1) * band
    img = lerp(img, hexc(pal['cloud']) * (0.7 + 0.6 * np.exp(-(d / 0.35) ** 2))[..., None], (cl * 0.55)[..., None])
    return img


def rays(img, sun, color, r, strength=0.18):
    yy, xx = np.mgrid[0:H, 0:W]
    ang = np.arctan2(yy - sun[1], xx - sun[0])
    n = 90
    a = r.uniform(0, 1, n)
    a = ndimage.gaussian_filter1d(np.tile(a, 3), 1.2)[n:2 * n]
    idx = ((ang + np.pi) / (2 * np.pi) * n).astype(int) % n
    d = np.hypot(xx - sun[0], yy - sun[1]) / W
    m = np.clip(a[idx] - 0.45, 0, 1) * 2 * np.exp(-d / 0.9) * (yy > sun[1] - 40)
    return img + hexc(color) * (m * strength)[..., None]


def ridge_layers(img, r, pal, layers, sun):
    """Ridges from far to near; each fades toward the haze colour with distance. Returns per-layer masks."""
    haze = hexc(pal['haze'])
    yy, xx = np.mgrid[0:H, 0:W]
    masks = []
    for i, L in enumerate(layers):
        prof = L['y'] * H + fbm1(r, W, 7, L.get('base', 3)) * L['amp'] * H
        if L.get('terrace'):
            # Graded pads: flat runs joined by short slopes.
            seg = max(30, int(W / 9))
            pads = np.repeat(ndimage.uniform_filter1d(prof, seg)[::seg], seg)[:W]
            pads = np.pad(pads, (0, W - len(pads)), mode='edge')
            prof = ndimage.uniform_filter1d(pads, 18)
        m = (yy >= prof[None, :]).astype(float)
        m = ndimage.gaussian_filter(m, 0.8)
        far = L['far']                               # 0 near … 1 far
        col = lerp(hexc(L['col']), haze, far)
        # Light from the sun on the ridge tops, shade going down.
        depth = np.clip((yy - prof[None, :]) / (H * 0.09), 0, 1)
        lit = np.exp(-((xx - sun[0]) / (W * 0.55)) ** 2) * (1 - depth) ** 3
        shade = lerp(col * 1.05 + hexc(pal['sun']) * 0.12 * lit[..., None], col * 0.45, depth[..., None] ** 0.6)
        tex = fbm2(r, H // 8, W // 8, 4, 3)
        tex = fit(tex, H, W)
        shade = shade * (1 + 0.06 * tex[..., None])
        img = lerp(img, shade, m[..., None])
        # Rim light along the ridge line.
        rim = np.exp(-((yy - prof[None, :]) / 2.2) ** 2) * (1 - far * 0.6) * (0.25 + 0.75 * np.exp(-((xx - sun[0]) / (W * 0.45)) ** 2))
        img += hexc(pal['rim']) * (rim * L.get('rim', 0.45))[..., None]
        # Haze pooled in the valley below the next layer.
        fog = np.exp(-((yy - (prof.mean() + H * 0.05)) / (H * 0.05)) ** 2) * L.get('fog', 0.25)
        img = lerp(img, haze, fog[..., None] * 0.35)
        masks.append((m, prof))
    return img, masks


def contour_glints(img, r, mask, prof, color, step=14, alpha=0.5):
    """Contour lines on a hill layer: level lines of a smooth height field, brighter toward the top."""
    yy, xx = np.mgrid[0:H, 0:W]
    h = fbm2(r, H // 30, W // 30, 4, 2)
    h = fit(h, H, W)
    field = (yy - prof[None, :]) / 6.0 + h * 26
    lines = np.abs(((field / step) % 1) - 0.5) * 2
    ln = np.clip((0.06 - (1 - lines)) / 0.06, 0, 1)
    ln = np.clip(1 - (1 - lines) / 0.07, 0, 1)
    fade = np.exp(-np.clip(yy - prof[None, :], 0, None) / (H * 0.22)) * mask
    return img + hexc(color) * (ln * fade * alpha)[..., None]


def blocks(img, r, pal, n=34, y0=0.55, y1=0.8):
    """Massing blocks: lit tops and two shaded sides, back to front, sinking into the haze."""
    haze = hexc(pal['haze'])
    out = img.copy()
    items = []
    for _ in range(n):
        y = r.uniform(y0, y1)
        items.append(y)
    items.sort()
    for y in items:
        far = 1 - (y - y0) / (y1 - y0)
        s = 0.35 + 0.65 * (1 - far)
        cx = r.uniform(-0.05, 1.05) * W
        w = r.uniform(70, 170) * s
        d = r.uniform(40, 110) * s
        h = r.uniform(50, 260) * s * (1.6 if r.uniform() < 0.12 else 1)
        base = y * H
        col = lerp(hexc(r.choice(pal['blocks'])), haze, far * 0.75)
        # Faces as polygons (simple oblique view: right side recedes up-right).
        dx, dy = d * 0.55, -d * 0.35
        front = [(cx - w / 2, base), (cx + w / 2, base), (cx + w / 2, base - h), (cx - w / 2, base - h)]
        side = [(cx + w / 2, base), (cx + w / 2 + dx, base + dy), (cx + w / 2 + dx, base + dy - h), (cx + w / 2, base - h)]
        top = [(cx - w / 2, base - h), (cx + w / 2, base - h), (cx + w / 2 + dx, base + dy - h), (cx - w / 2 + dx, base + dy - h)]
        for poly, k in ((front, 0.62), (side, 0.42), (top, 1.15)):
            m = poly_mask(poly)
            out = lerp(out, np.clip(col * k + (hexc(pal['sun']) * 0.12 if k > 1 else 0), 0, 1.4), m[..., None])
        # Lit edge at the top front.
        e = poly_mask([(cx - w / 2, base - h - 1.2), (cx + w / 2 + dx, base + dy - h - 1.2), (cx + w / 2 + dx, base + dy - h + 0.8), (cx - w / 2, base - h + 0.8)])
        out += hexc(pal['rim']) * (e * 0.5 * (1 - far * 0.7))[..., None]
        # Ground haze in front of each row.
        yy = np.arange(H)[:, None]
        fog = np.exp(-((yy - base - 10) / 40) ** 2) * 0.08
        out = lerp(out, np.broadcast_to(haze, out.shape), fog[..., None])
    return out


_grid = None


def poly_mask(poly):
    from PIL import ImageDraw
    m = Image.new('L', (W * 2, H * 2), 0)
    ImageDraw.Draw(m).polygon([(x * 2, y * 2) for x, y in poly], fill=255)
    return np.asarray(m.resize((W, H), Image.BILINEAR), float) / 255


def drafting(img, color, r, alpha=0.35):
    """Architect's construction geometry over the scene: circles, guide lines, an arrow, tick marks."""
    from PIL import ImageDraw
    m = Image.new('L', (W * 2, H * 2), 0)
    d = ImageDraw.Draw(m)
    S = 2
    cx, cy = W * 0.62 * S, H * 0.3 * S
    for rr in (150, 230, 330):
        d.ellipse([cx - rr * S, cy - rr * S, cx + rr * S, cy + rr * S], outline=170, width=2)
    for a in np.linspace(0, np.pi, 7):
        d.line([cx - np.cos(a) * 420 * S, cy - np.sin(a) * 420 * S, cx + np.cos(a) * 420 * S, cy + np.sin(a) * 420 * S], fill=90, width=1)
    for x in range(0, W * S, 36 * S):
        d.line([x, H * 0.47 * S, x, H * 0.47 * S + 10 * S], fill=160, width=2)
    d.line([0, H * 0.47 * S, W * S, H * 0.47 * S], fill=160, width=2)
    # Sweeping arrow.
    pts = [(W * 0.08 * S + t * W * 0.7 * S, H * 0.62 * S - np.sin(t * np.pi) * 160 * S) for t in np.linspace(0, 1, 40)]
    d.line(pts, fill=230, width=7 * S // 2, joint='curve')
    ex, ey = pts[-1]
    d.polygon([(ex + 26 * S, ey + 4 * S), (ex - 10 * S, ey - 22 * S), (ex - 4 * S, ey + 22 * S)], fill=230)
    a = np.asarray(m.resize((W, H), Image.BILINEAR), float) / 255
    return img + hexc(color) * (a * alpha)[..., None]


def finish(img, r, name, pal):
    yy, xx = np.mgrid[0:H, 0:W]
    # Painterly softening: blend a blurred copy, keep some detail.
    im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    soft = np.asarray(im.filter(ImageFilter.GaussianBlur(1.6)), float) / 255
    img = lerp(np.clip(img, 0, 1), soft, 0.5)
    # Vignette and a dark foot (the menus sit over the lower part).
    v = np.hypot((xx - W / 2) / W, (yy - H * 0.35) / H)
    img *= (1 - 0.55 * np.clip(v - 0.25, 0, 1) ** 1.2)[..., None]
    foot = np.clip((yy / H - 0.62) / 0.38, 0, 1) ** 1.3
    img = lerp(img, hexc(pal['foot']), (foot * 0.82)[..., None])
    # Grain.
    img += r.normal(0, 0.018, (H, W, 1))
    img = np.clip(img, 0, 1)
    Image.fromarray((img * 255).astype(np.uint8)).save(f'{OUT}key-{name}.jpg', quality=80, optimize=True, progressive=True)
    print(name, 'ok')


SCENES = {
    'existing': dict(seed=7, sun=(0.7, 0.3), pal=dict(top='#0d2230', mid='#2e5b63', low='#c9b48a', sun='#ffd9a0', cloud='#f3d6b0', haze='#6f9a98', rim='#ffe2b0', foot='#0b1418'),
                     layers=[dict(y=0.36, amp=0.05, far=0.85, col='#2c5257', fog=0.3), dict(y=0.42, amp=0.06, far=0.62, col='#21454a', fog=0.3),
                             dict(y=0.5, amp=0.07, far=0.38, col='#163338', fog=0.25), dict(y=0.6, amp=0.08, far=0.12, col='#0d2226', fog=0.15, rim=0.6)]),
    'design': dict(seed=21, sun=(0.3, 0.32), pal=dict(top='#24150c', mid='#7a4a22', low='#f0c27a', sun='#ffc76b', cloud='#ffd9a0', haze='#b98a58', rim='#ffd08a', foot='#160e08'),
                   layers=[dict(y=0.37, amp=0.04, far=0.85, col='#6a4626', fog=0.3), dict(y=0.44, amp=0.05, far=0.6, col='#563619', terrace=14, fog=0.25),
                           dict(y=0.52, amp=0.06, far=0.35, col='#3f2712', terrace=22, fog=0.2), dict(y=0.62, amp=0.05, far=0.1, col='#2a190b', terrace=30, fog=0.1, rim=0.65)]),
    'sketch': dict(seed=33, sun=(0.5, 0.34), pal=dict(top='#0c0e24', mid='#373a7a', low='#d7a6b5', sun='#ffc7c0', cloud='#c9b6e4', haze='#6a6aa6', rim='#e9d9ff', foot='#0a0b18', blocks=['#4b4f9a', '#5a5fb0', '#3e4285', '#6b6fc0']),
                   layers=[dict(y=0.4, amp=0.03, far=0.85, col='#3b3d78', fog=0.35), dict(y=0.46, amp=0.03, far=0.6, col='#2b2d63', fog=0.3), dict(y=0.5, amp=0.004, far=0.3, col='#1d1f4a', fog=0.1, rim=0.2)]),
    'diagram': dict(seed=45, sun=(0.62, 0.3), pal=dict(top='#1a0c1c', mid='#6a2c56', low='#f0b6a8', sun='#ffd1c2', cloud='#f2c0d0', haze='#9a5a84', rim='#ffd8e8', foot='#140a14'),
                    layers=[dict(y=0.4, amp=0.04, far=0.85, col='#5c2a4d', fog=0.3), dict(y=0.47, amp=0.05, far=0.6, col='#46203c', fog=0.25),
                            dict(y=0.56, amp=0.05, far=0.3, col='#30152a', fog=0.2), dict(y=0.64, amp=0.05, far=0.08, col='#200c1c', fog=0.1, rim=0.55)]),
}

if __name__ == '__main__':
    for name, S in SCENES.items():
        r = rng(S['seed'])
        pal = S['pal']
        sun = (S['sun'][0] * W, S['sun'][1] * H)
        img = sky(pal, r, sun)
        img = rays(img, sun, pal['sun'], r, 0.1)
        img, masks = ridge_layers(img, r, pal, S['layers'], sun)
        if name == 'existing':
            for (m, prof), c in zip(masks[1:], (0.1, 0.16, 0.26)):
                img = contour_glints(img, r, m, prof, pal['rim'], 13, c)
        if name == 'design':
            img = contour_glints(img, r, masks[-1][0], masks[-1][1], pal['rim'], 18, 0.18)
        if name == 'sketch':
            img = blocks(img, r, pal, 46, 0.5, 0.64)
        if name == 'diagram':
            img = drafting(img, pal['rim'], r, 0.32)
        finish(img, r, name, pal)
