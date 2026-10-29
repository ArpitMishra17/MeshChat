#!/usr/bin/env python3
"""
Generates MeshChat's app icons from one geometric spec.

    python3 scripts/generate-icons.py

Writes assets/icon.png, android-icon-{foreground,background,monochrome}.png,
splash-icon.png, favicon.png and assets/logo.svg (mark only).

The mark is the radar view from the app: a lime square ("you") linked to
neighbours — a green live link, a hollow steel node, and an amber dashed
link to a node that is only reachable through the relay edge. Palette and
display font match src/theme.
"""
import math
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ASSETS = os.path.join(ROOT, 'assets')
FONT = os.path.join(ROOT, 'node_modules/@expo-google-fonts/chakra-petch/700Bold/ChakraPetch_700Bold.ttf')

BG = (8, 9, 10)
LIME = (216, 242, 75)
GREEN = (92, 230, 92)
AMBER = (242, 169, 59)
STEEL = (139, 148, 144)
EDGE = (69, 78, 80)
WHITE = (242, 246, 244)

# Mark geometry in a 1024 design space, centred on (512, 512).
YOU = (512, 512)
YOU_SIDE = 132
N_LIVE = (748, 340)    # linked neighbour
N_STEEL = (318, 322)   # known, no live link
N_RELAY = (372, 736)   # reached via the relay edge
N_FAR = (738, 722)     # relay hop
NODE_R = 46
FAR_R = 34
HALO_R = 70
GAP = 4


def _trim(a, b, ra, rb):
    """Shorten segment a-b so it stops at the node boundaries (radii ra, rb)."""
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    return ((a[0] + ux * ra, a[1] + uy * ra), (b[0] - ux * rb, b[1] - uy * rb))


# (a, b, colour, width, dash) — trimmed so edges never cross a hollow node.
EDGES = [
    (*_trim(YOU, N_LIVE, 0, NODE_R + GAP), LIME, 16, None),
    (*_trim(YOU, N_STEEL, 0, NODE_R + GAP), EDGE, 10, None),
    (*_trim(YOU, N_RELAY, 0, NODE_R + GAP), AMBER, 10, (34, 26)),
    (*_trim(N_LIVE, N_FAR, NODE_R + GAP, FAR_R + GAP), EDGE, 8, (28, 22)),
    (*_trim(N_FAR, N_RELAY, FAR_R + GAP, NODE_R + GAP), EDGE, 8, (28, 22)),
]

# Farthest any drawn pixel gets from YOU (design space) — used to auto-fit the
# mark inside launcher safe zones.
R_MAX = max(
    math.hypot(N_LIVE[0] - YOU[0], N_LIVE[1] - YOU[1]) + HALO_R,
    math.hypot(N_STEEL[0] - YOU[0], N_STEEL[1] - YOU[1]) + NODE_R,
    math.hypot(N_RELAY[0] - YOU[0], N_RELAY[1] - YOU[1]) + NODE_R,
    math.hypot(N_FAR[0] - YOU[0], N_FAR[1] - YOU[1]) + FAR_R,
)


def _dashed(d, a, b, color, width, dash=34, gap=26):
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
    pos = 0.0
    while pos < length:
        end = min(pos + dash, length)
        d.line([(a[0] + ux * pos, a[1] + uy * pos), (a[0] + ux * end, a[1] + uy * end)], fill=color, width=width)
        pos += dash + gap


def draw_mark(d, cx, cy, s, bg, mono=None):
    """Draw the mark on `d`, centred at (cx, cy), scaled by `s`. `mono` = single colour."""
    def P(p):  # design space -> canvas
        return (cx + (p[0] - 512) * s, cy + (p[1] - 512) * s)

    def c(color):
        return mono or color

    w = lambda n: max(1, round(n * s))
    for a, b, col, wd, dash in EDGES:
        col = c(col)
        if dash:
            _dashed(d, P(a), P(b), col, w(wd), dash[0] * s, dash[1] * s)
        else:
            d.line([P(a), P(b)], fill=col, width=w(wd))

    def ring(p, r, color, stroke):
        x, y = P(p)
        d.ellipse([x - r * s, y - r * s, x + r * s, y + r * s], fill=bg if not mono else None, outline=c(color), width=w(stroke))

    # live neighbour: solid + halo
    x, y = P(N_LIVE)
    d.ellipse([x - HALO_R * s, y - HALO_R * s, x + HALO_R * s, y + HALO_R * s], outline=c((46, 115, 46)) if not mono else mono, width=w(8))
    d.ellipse([x - NODE_R * s, y - NODE_R * s, x + NODE_R * s, y + NODE_R * s], fill=c(GREEN))
    ring(N_STEEL, NODE_R, STEEL, 13)
    ring(N_RELAY, NODE_R, AMBER, 13)
    ring(N_FAR, FAR_R, EDGE if not mono else mono, 11)

    # you
    x, y = P(YOU)
    h = YOU_SIDE / 2 * s
    d.rectangle([x - h, y - h, x + h, y + h], fill=c(LIME))


def crop_marks(d, size, color, inset=88, arm=96, thick=12):
    for sx in (0, 1):
        for sy in (0, 1):
            x = inset if sx == 0 else size - inset
            y = inset if sy == 0 else size - inset
            dx = 1 if sx == 0 else -1
            dy = 1 if sy == 0 else -1
            d.rectangle(sorted([x, x + dx * arm]) and [min(x, x + dx * arm), min(y, y + dy * thick), max(x, x + dx * arm), max(y, y + dy * thick)], fill=color)
            d.rectangle([min(x, x + dx * thick), min(y, y + dy * arm), max(x, x + dx * thick), max(y, y + dy * arm)], fill=color)


SS = 4  # supersample factor for anti-aliasing


def render(size, bg, mark_scale, frame=False, mono=None, transparent=False, offset=(0, 0), wordmark=False):
    big = size * SS
    mode = 'RGBA'
    img = Image.new(mode, (big, big), (0, 0, 0, 0) if transparent else bg + (255,))
    d = ImageDraw.Draw(img)
    if frame:
        crop_marks(d, big, LIME, inset=88 * SS * size / 1024 / 1, arm=96 * SS * size / 1024, thick=12 * SS * size / 1024)
    cx = big / 2 + offset[0] * SS
    cy = big / 2 + offset[1] * SS
    draw_mark(d, cx, cy, mark_scale * SS * size / 1024, bg, mono)
    if wordmark:
        f = ImageFont.truetype(FONT, int(0.118 * big))
        a, b = 'MESH', 'CHAT'
        wa = d.textlength(a, font=f)
        wb = d.textlength(b, font=f)
        # letter-spacing
        sp = 0.012 * big
        total = wa + wb + sp * 7
        x = (big - total) / 2
        y = big * 0.80
        for ch in a:
            d.text((x, y), ch, font=f, fill=WHITE)
            x += d.textlength(ch, font=f) + sp
        for ch in b:
            d.text((x, y), ch, font=f, fill=LIME)
            x += d.textlength(ch, font=f) + sp
    return img.resize((size, size), Image.LANCZOS)


def save(img, name, flatten=False):
    path = os.path.join(ASSETS, name)
    if flatten:
        img = img.convert('RGB')
    img.save(path)
    print('wrote', os.path.relpath(path, ROOT), img.size)


def svg():
    hx = lambda c: '#%02x%02x%02x' % c
    ring = lambda p, r, col, w: f'<circle cx="{p[0]}" cy="{p[1]}" r="{r}" fill="{hx(BG)}" stroke="{hx(col)}" stroke-width="{w}"/>'
    lines = []
    for a, b, col, wd, dash in EDGES:
        da = f' stroke-dasharray="{dash[0]} {dash[1]}"' if dash else ''
        lines.append(f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}" stroke="{hx(col)}" stroke-width="{wd}"{da}/>')
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">',
        f'<rect width="1024" height="1024" fill="{hx(BG)}"/>',
        *lines,
        f'<circle cx="{N_LIVE[0]}" cy="{N_LIVE[1]}" r="{HALO_R}" fill="none" stroke="#2e732e" stroke-width="8"/>',
        f'<circle cx="{N_LIVE[0]}" cy="{N_LIVE[1]}" r="{NODE_R}" fill="{hx(GREEN)}"/>',
        ring(N_STEEL, NODE_R, STEEL, 13), ring(N_RELAY, NODE_R, AMBER, 13), ring(N_FAR, FAR_R, EDGE, 11),
        f'<rect x="{YOU[0]-YOU_SIDE/2}" y="{YOU[1]-YOU_SIDE/2}" width="{YOU_SIDE}" height="{YOU_SIDE}" fill="{hx(LIME)}"/>',
        '</svg>',
    ]
    with open(os.path.join(ASSETS, 'logo.svg'), 'w') as f:
        f.write('\n'.join(parts) + '\n')
    print('wrote assets/logo.svg')


if __name__ == '__main__':
    # iOS / store icon: full-bleed, opaque, with crop marks.
    save(render(1024, BG, 0.95, frame=True), 'icon.png', flatten=True)
    # Android adaptive: keep every pixel inside the guaranteed-safe central
    # 66dp-of-108dp circle, so no launcher mask can clip the mark.
    safe = lambda size: 0.305 * size  # safe-circle radius in px
    fit = lambda size: safe(size) * 0.97 / R_MAX * (1024 / size)  # design-space scale arg
    save(render(512, BG, fit(512), transparent=True), 'android-icon-foreground.png')
    save(Image.new('RGBA', (512, 512), BG + (255,)), 'android-icon-background.png')
    save(render(432, BG, fit(432), mono=(255, 255, 255), transparent=True), 'android-icon-monochrome.png')
    # Splash: mark + wordmark on transparent (background colour comes from app.json).
    save(render(1024, BG, 0.70, transparent=True, offset=(0, -90), wordmark=True), 'splash-icon.png')
    save(render(48, BG, 1.0, frame=False), 'favicon.png', flatten=True)
    svg()
