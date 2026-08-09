#!/usr/bin/env python3
"""像素鲸鱼 v4：基于参考图投票骨架精修（40x29）。
1. 投票降采样 + 多数平滑 -> 形状骨架
2. 精修：眼睛规整为圆润大眼 + 瞳孔、尾巴深蓝、状态表情覆盖
3. 输出对比图（参考图 vs 像素版）
"""
from PIL import Image, ImageDraw
import os

SW, SH = 640, 464
W, H = 40, 29
SCALE = 12

# ---------- 1. 投票骨架 ----------
def vote_skeleton():
    img = Image.open(os.path.join(os.path.dirname(__file__), '..', 'reference whale.png')).convert('RGB')
    px = img.load()
    def is_blue(r, g, b): return b > r + 25 and b > 150
    g = [[0] * W for _ in range(H)]
    for gy in range(H):
        y0, y1 = int(gy * SH / H), int((gy + 1) * SH / H)
        for gx in range(W):
            x0, x1 = int(gx * SW / W), int((gx + 1) * SW / W)
            blue = sum(1 for yy in range(y0, y1, 2) for xx in range(x0, x1, 2) if is_blue(*px[xx, yy]))
            total = ((x1 - x0 + 1) // 2) * ((y1 - y0 + 1) // 2)
            g[gy][gx] = 1 if blue > total / 2 else 0
    for _ in range(2):
        ng = [row[:] for row in g]
        for y in range(H):
            for x in range(W):
                cnt = sum(g[y + dy][x + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                          if 0 <= y + dy < H and 0 <= x + dx < W)
                ng[y][x] = 1 if cnt >= 5 else 0
        g = ng
    return g

# ---------- 2. 精修：骨架 -> 上色网格 ----------
def refine(skel):
    grid = [['.'] * W for _ in range(H)]
    BODY_MAX_X = 21  # 身体右边界（尾巴从 x=21 开始）
    # 身体左半：蓝格 -> b，蓝格范围内的空白 -> E（眼睛/嘴凹陷）
    for y in range(H):
        blues = [x for x in range(W) if skel[y][x] and x < BODY_MAX_X]
        if not blues:
            continue
        lo, hi = min(blues), max(blues)
        for x in range(lo, min(hi, BODY_MAX_X - 1) + 1):
            grid[y][x] = 'b' if skel[y][x] else 'E'
    # 尾巴（x >= BODY_MAX_X 的蓝）-> 深蓝 B
    for y in range(H):
        for x in range(W):
            if skel[y][x] and x >= BODY_MAX_X:
                grid[y][x] = 'B'
    return grid

# ---------- 3. 眼睛 + 表情（覆盖在身体上）----------
# 眼睛区域（参考图左缘大眼，规整为圆润形状）
EYE = {
    13: (9, 12), 14: (8, 14), 15: (7, 16), 16: (7, 16),
    17: (8, 17), 18: (9, 17), 19: (10, 17), 20: (11, 16),
}

def face(mode, grid):
    # 收集 'E' 凹陷区域（自动来自骨架），按行记录边界
    eye_rows = {}
    for y in range(H):
        xs = [x for x in range(W) if grid[y][x] == 'E']
        if xs:
            eye_rows[y] = (min(xs), max(xs))
    if not eye_rows:
        return grid
    ymin, ymax = min(eye_rows), max(eye_rows)

    for y in range(H):
        if y not in eye_rows:
            continue
        x0, x1 = eye_rows[y]
        for x in range(x0, x1 + 1):
            if mode == 'default':
                grid[y][x] = 'K' if (x >= x1 - 1 and y in (ymin + 2, ymin + 3)) else 'w'
            elif mode == 'working':
                # 专注：眯眼（上半部身体色，下半部眼白+瞳孔）
                if y >= ymin + 3:
                    grid[y][x] = 'K' if (x >= x1 - 2 and y in (ymin + 4, ymin + 5)) else 'w'
                else:
                    grid[y][x] = 'b'
            elif mode == 'attention':
                grid[y][x] = 'K' if (x >= x1 - 2 and ymin + 2 <= y <= ymin + 5) else 'w'
            elif mode == 'done':
                # ^^ 开心眼
                if y <= ymin + 1:
                    grid[y][x] = 'K' if x in (x0, x1) else 'b'
                elif ymin + 2 <= y <= ymin + 3 and x0 + 1 <= x <= x1 - 1:
                    grid[y][x] = 'K'
                else:
                    grid[y][x] = 'b'
            elif mode == 'idle':
                grid[y][x] = 'K' if (ymin + 3 <= y <= ymin + 4 and x0 + 1 <= x <= x1 - 1) else 'b'
            elif mode == 'offline':
                # X 眼
                mid = (x0 + x1) // 2
                top, bot = ymin + 1, ymax - 1
                if (y == top and x in (x0, x1)) or (y == mid - ymin + ymin and x == mid) or (y == bot and x in (x0, x1)):
                    grid[y][x] = 'K'
                else:
                    grid[y][x] = 'b'
    # 嘴（眼睛右下方的凹陷沿用骨架；额外表情嘴）
    if mode == 'attention':
        for y in range(ymax + 1, min(H, ymax + 3)):
            for x in range(W):
                if grid[y][x] == 'E':
                    grid[y][x] = 'K'
    if mode == 'done':
        y = min(H - 1, ymax + 1)
        for x in range(W):
            if grid[y][x] == 'E':
                grid[y][x] = 'K'
    # 腮红（眼睛左侧下方）
    if mode not in ('offline',):
        bx, by = x0 - 2 if x0 >= 3 else 3, ymax - 1
        if by < H and 0 <= bx < W and grid[by][bx] == 'b':
            grid[by][bx] = 'P'
        if by + 1 < H and grid[by + 1][bx] == 'b':
            grid[by + 1][bx] = 'P'
    # 喷水柱
    if mode in ('working', 'done'):
        for y in range(2, 6):
            grid[y][11] = 'R'; grid[y][12] = 'R'
    return grid

# ---------- 输出 ----------
COLORS = {
    '.': (0, 0, 0, 0), 'b': (84, 106, 245, 255), 'B': (46, 70, 208, 255),
    'w': (255, 255, 255, 255), 'K': (15, 27, 77, 255), 'P': (255, 158, 187, 255),
    'R': (143, 176, 255, 255),
}
GRAY = {
    '.': (0, 0, 0, 0), 'b': (154, 163, 184, 255), 'B': (110, 118, 144, 255),
    'w': (240, 242, 247, 255), 'K': (58, 65, 84, 255), 'P': (154, 163, 184, 255),
    'R': (154, 163, 184, 255),
}

def render_png(grid, path, gray=False):
    cols = GRAY if gray else COLORS
    img = Image.new('RGBA', (W * SCALE, H * SCALE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(H):
        for x in range(W):
            d.rectangle([x * SCALE, y * SCALE, (x + 1) * SCALE - 1, (y + 1) * SCALE - 1], fill=cols[grid[y][x]])
    img.save(path)

def build(mode):
    grid = refine(vote_skeleton())
    return face(mode, grid)

if __name__ == '__main__':
    outdir = os.path.join(os.path.dirname(__file__), '..', 'pixel-preview')
    os.makedirs(outdir, exist_ok=True)
    for mode in ['default', 'working', 'attention', 'done', 'idle', 'offline']:
        g = build(mode)
        print(f"===== {mode} =====")
        for i, row in enumerate(g):
            print(f"{i:2d}|{''.join(row)}|")
        render_png(g, os.path.join(outdir, f'v4-{mode}.png'), gray=(mode == 'offline'))

    # 对比图：参考图 vs default
    mine = Image.open(os.path.join(outdir, 'v4-default.png'))
    ref = Image.open(os.path.join(os.path.dirname(__file__), '..', 'reference whale.png')).convert('RGBA')
    ref = ref.resize((int(ref.width * mine.height / ref.height), mine.height))
    gap = 40
    canvas = Image.new('RGBA', (ref.width + gap + mine.width, mine.height), (250, 250, 252, 255))
    canvas.paste(ref, (0, 0))
    d = ImageDraw.Draw(canvas)
    d.rectangle([ref.width + gap // 2 - 2, 10, ref.width + gap // 2, mine.height - 10], fill=(180, 185, 200, 255))
    canvas.paste(mine, (ref.width + gap, 0))
    canvas.save(os.path.join(outdir, 'comparison-v4.png'))
    print('-> comparison-v4.png')
