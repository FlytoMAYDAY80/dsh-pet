#!/usr/bin/env python3
"""程序化像素鲸鱼生成器 v2：
- 身体：数学椭圆（保证圆润）
- 尾巴：贝塞尔曲线采样 + 距离场填充（保证是弯曲的大尾鳍）
- 状态表情：覆盖层
输出：ASCII 预览 + PNG 图片（供用户查看反馈）
"""
from PIL import Image, ImageDraw
import math

W, H = 26, 21
SCALE = 14  # PNG 放大倍数

# ---- 几何定义 ----
BODY_CX, BODY_CY, BODY_RX, BODY_RY = 11, 12, 8.3, 7.3      # 身体椭圆
BELLY_CX, BELLY_CY, BELLY_RX, BELLY_RY = 10.5, 15.5, 5.2, 3.2  # 肚皮椭圆
TAIL_PTS = [(18, 13), (23.5, 13), (26, 8), (25, 1)]        # 尾鳍中心线贝塞尔（更向上翘）
TAIL_WIDTH = 3.0  # 尾鳍半径（更宽，像大叶片）

def bezier(pts, t):
    p = list(pts)
    while len(p) > 1:
        p = [( (1 - t) * p[i][0] + t * p[i + 1][0], (1 - t) * p[i][1] + t * p[i + 1][1] ) for i in range(len(p) - 1)]
    return p[0]

def tail_dist(x, y):
    d = 1e9
    for i in range(101):
        t = i / 100
        px, py = bezier(TAIL_PTS, t)
        d = min(d, math.hypot(x - px, y - py))
    return d

def in_ellipse(x, y, cx, cy, rx, ry):
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1

# ---- 表情定义（覆盖身体的脸部区域）----
# 眼睛位于身体左前 (col 6-8, row 8-9)；字符优先级高于身体
def eye_pixels(mode, x, y):
    """返回该像素在脸部应显示的颜色字符，None 表示用身体色"""
    # 眼区坐标
    if 6 <= x <= 8 and 8 <= y <= 9:
        if mode == 'default':
            if x == 8: return 'K'          # 瞳孔列
            return 'w'                      # 眼白
        if mode == 'working':               # 专注：眼白收窄+瞳孔
            if x == 7 and y == 9: return 'K'
            if x == 6 and y == 9: return 'w'
            return 'b'                      # 其余眯眼（身体色）
        if mode == 'attention':             # 惊：大眼白+大瞳孔
            if x == 8 and y == 9: return 'K'
            if x == 8 and y == 8: return 'K'
            if x == 7: return 'w'
            if x == 6: return 'w'
            return 'b'
        if mode in ('done',):               # ^^ 开心眼
            if (x == 6 and y == 8) or (x == 8 and y == 8): return 'K'
            if x == 7 and y == 9: return 'K'
            return 'b'
        if mode == 'idle':                  # 睡觉横线
            if y == 9 and x in (6, 7, 8): return 'K'
            return 'b'
        if mode == 'offline':               # X 眼
            if (x == 6 and y == 8) or (x == 8 and y == 8) or (x == 7 and y == 9) or (x == 6 and y == 10) or (x == 8 and y == 10):
                return 'K'
            return 'b'
    # 嘴
    if mode == 'attention' and x == 8 and y == 12: return 'K'
    if mode == 'done' and x == 7 and y == 13: return 'K'
    # 腮红
    if x == 4 and y == 11: return 'P'
    if x == 5 and y == 11 and mode not in ('offline',): return 'P'
    # 喷水柱（working/done）
    if mode in ('working', 'done') and x in (11, 12) and y in (1, 2, 3, 4):
        return 'R'
    return None

def build_sprite(mode):
    grid = [['.'] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            # 喷水柱（working/done）— 位于头顶，身体之外
            if mode in ('working', 'done') and x in (11, 12) and y in (1, 2, 3, 4):
                grid[y][x] = 'R'
                continue
            # 尾巴优先（深蓝，位于身体右上方）
            if tail_dist(x, y) < TAIL_WIDTH:
                grid[y][x] = 'B'
                continue
            # 身体
            if in_ellipse(x + 0.5, y + 0.5, BODY_CX, BODY_CY, BODY_RX, BODY_RY):
                # 肚皮
                if in_ellipse(x + 0.5, y + 0.5, BELLY_CX, BELLY_CY, BELLY_RX, BELLY_RY):
                    grid[y][x] = 'W'
                else:
                    grid[y][x] = 'b'
                # 脸部覆盖
                fc = eye_pixels(mode, x, y)
                if fc:
                    grid[y][x] = fc
    return grid

# ---- 输出 ----
COLORS = {
    '.': (255, 255, 255, 0), 'b': (77, 107, 254, 255), 'B': (46, 70, 208, 255),
    'W': (220, 228, 255, 255), 'w': (255, 255, 255, 255), 'K': (15, 27, 77, 255),
    'P': (255, 158, 187, 255), 'R': (143, 176, 255, 255),
    'G': (154, 163, 184, 255),
}

GRAY_COLORS = {
    '.': (255, 255, 255, 0), 'b': (154, 163, 184, 255), 'B': (110, 118, 144, 255),
    'W': (217, 221, 232, 255), 'w': (240, 242, 247, 255), 'K': (58, 65, 84, 255),
    'P': (154, 163, 184, 255), 'R': (154, 163, 184, 255),
}

def render_png(grid, path, gray=False):
    cols = GRAY_COLORS if gray else COLORS
    img = Image.new('RGBA', (W * SCALE, H * SCALE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(H):
        for x in range(W):
            ch = grid[y][x]
            d.rectangle([x * SCALE, y * SCALE, (x + 1) * SCALE - 1, (y + 1) * SCALE - 1], fill=cols[ch])
    img.save(path)

def show_ascii(grid, name):
    print(f"===== {name} =====")
    for row in grid:
        print(' ' + ' '.join(row))

if __name__ == '__main__':
    import os
    outdir = os.path.join(os.path.dirname(__file__), '..', '.pixel-design')
    os.makedirs(outdir, exist_ok=True)
    for mode in ['default', 'working', 'attention', 'done', 'idle', 'offline']:
        grid = build_sprite(mode)
        show_ascii(grid, mode)
        render_png(grid, os.path.join(outdir, f'{mode}.png'), gray=(mode == 'offline'))
        print(f'  -> .pixel-design/{mode}.png')
