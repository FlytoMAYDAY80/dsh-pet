#!/usr/bin/env python3
"""像素鲸鱼 v3：参考 reference whale.png 的轮廓校准。
- 身体：椭圆（cx=10.5, cy=11, rx=6.2, ry=6.8）
- 尾巴：贝塞尔叶片，从身体右侧向右上翘（与身体有缺口）
- 眼睛：身体左前大眼（参考图的眼睛凹陷区）
输出 ASCII + PNG（到可见目录 pixel-preview/）
"""
from PIL import Image, ImageDraw
import math, os

W, H = 26, 21
SCALE = 14

def bezier(pts, t):
    p = list(pts)
    while len(p) > 1:
        p = [((1 - t) * p[i][0] + t * p[i + 1][0], (1 - t) * p[i][1] + t * p[i + 1][1]) for i in range(len(p) - 1)]
    return p[0]

TAIL_PTS = [(17, 12), (22.5, 12.2), (24.8, 7.5), (23.8, 2.8)]  # 尾鳍中心线：水平伸出后上翘
TAIL_W = 2.6

def tail_dist(x, y):
    return min(math.hypot(x - bx, y - by) for i in range(121) for bx, by in [bezier(TAIL_PTS, i / 120)])

def in_ell(x, y, cx, cy, rx, ry):
    return ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1

# 尾巴叶片：上缘上翘、下缘近水平（参考图尾鳍形状）
def in_tail(x, y):
    # 多边形近似：尖顶 (23.5,2.5) -> 上缘 -> 后缘 -> 下缘 -> 身体侧
    pts = [(16, 9.5), (23, 2), (25, 3.5), (25.5, 9), (24, 13), (18.5, 13), (16, 11)]
    n = len(pts)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]; xj, yj = pts[j]
        if (yi > y + 0.5) != (yj > y + 0.5) and (x + 0.5) < (xj - xi) * (y + 0.5 - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

# 眼睛：身体左前的大眼（眼区 x4-8, y10-13；x8 为瞳孔列）
def eye_cell(mode, x, y):
    if 4 <= x <= 8 and 10 <= y <= 13:
        if mode == 'default':
            return 'K' if x == 8 else 'w'
        if mode == 'working':
            if x == 8 and y >= 11: return 'K'   # 瞳孔偏下
            if x in (6, 7) and y >= 12: return 'w'
            return 'b'                           # 半眯
        if mode == 'attention':
            if x in (7, 8) and y in (11, 12): return 'K'
            return 'w'
        if mode == 'done':
            if (x in (5, 8) and y in (10, 11)) or (x == 7 and y == 13): return 'K'
            return 'b'
        if mode == 'idle':
            if y == 12 and 6 <= x <= 8: return 'K'
            return 'b'
        if mode == 'offline':
            if (x, y) in ((5, 10), (8, 10), (6, 12), (5, 13), (8, 13)): return 'K'
            return 'b'
    # 嘴
    if mode == 'attention' and x == 7 and y == 15: return 'K'
    if mode == 'done' and x == 6 and y == 15: return 'K'
    # 腮红（眼睛左下方）
    if x == 3 and y == 13: return 'P'
    if x == 4 and y == 13 and mode not in ('offline',): return 'P'
    # 喷水柱（头顶）
    if mode in ('working', 'done') and x in (10, 11) and y in (1, 2, 3, 4):
        return 'R'
    return None

def build(mode):
    g = [['.'] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            if mode in ('working', 'done') and x in (10, 11) and y in (1, 2, 3, 4):
                g[y][x] = 'R'
                continue
            if in_tail(x, y):
                g[y][x] = 'B'
                continue
            if in_ell(x, y, 10.5, 11, 5.5, 6.5):
                if in_ell(x, y, 9, 15, 4, 2.4):
                    g[y][x] = 'W'
                else:
                    g[y][x] = 'b'
                fc = eye_cell(mode, x, y)
                if fc:
                    g[y][x] = fc
    return g

COLORS = {
    '.': (255, 255, 255, 0), 'b': (84, 106, 245, 255), 'B': (46, 70, 208, 255),
    'W': (220, 228, 255, 255), 'w': (255, 255, 255, 255), 'K': (15, 27, 77, 255),
    'P': (255, 158, 187, 255), 'R': (143, 176, 255, 255),
}
GRAY = {
    '.': (255, 255, 255, 0), 'b': (154, 163, 184, 255), 'B': (110, 118, 144, 255),
    'W': (217, 221, 232, 255), 'w': (240, 242, 247, 255), 'K': (58, 65, 84, 255),
    'P': (154, 163, 184, 255), 'R': (154, 163, 184, 255),
}

def render_png(g, path, gray=False):
    cols = GRAY if gray else COLORS
    img = Image.new('RGBA', (W * SCALE, H * SCALE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(H):
        for x in range(W):
            d.rectangle([x * SCALE, y * SCALE, (x + 1) * SCALE - 1, (y + 1) * SCALE - 1], fill=cols[g[y][x]])
    img.save(path)

if __name__ == '__main__':
    outdir = os.path.join(os.path.dirname(__file__), '..', 'pixel-preview')
    os.makedirs(outdir, exist_ok=True)
    for mode in ['default', 'working', 'attention', 'done', 'idle', 'offline']:
        g = build(mode)
        print(f"===== {mode} =====")
        for i, row in enumerate(g):
            print(f"{i:2d}|" + ''.join(row) + '|')
        render_png(g, os.path.join(outdir, f'{mode}.png'), gray=(mode == 'offline'))
        print(f'  -> pixel-preview/{mode}.png')
