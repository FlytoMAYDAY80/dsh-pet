#!/usr/bin/env python3
"""把参考图转成桌宠自定义素材包 custom/sprites.json（80x58，6 状态）。

用法: python3 scripts/ref_to_sprites.py <参考图路径>
输出: custom/sprites.json（覆盖默认像素素材）

流程: 投票降采样 40x29 + 平滑 -> 身体/尾巴/凹陷识别 -> 6 状态表情覆盖
      -> 2x2 放大到 80x58 -> 写入 custom/sprites.json
"""
import json
import math
import os
import sys
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'custom', 'sprites.json')
LW, LH = 40, 29  # 逻辑网格

# 内置调色板（输出沿用）
PALETTE = {
    '.': '#00000000', 'b': '#546AF5', 'B': '#2E46D0', 'w': '#FFFFFF',
    'K': '#0F1B4D', 'P': '#FF9EBB', 'R': '#8FB0FF',
    'g': '#9AA3B8', 'G': '#6E7690', 'q': '#F0F2F7', 'k': '#3A4154',
}
# 离线状态：彩色 -> 灰阶
GRAY_MAP = {'b': 'g', 'B': 'G', 'w': 'q', 'K': 'k', 'P': 'g', 'R': 'g'}


def is_blue(r, g, b):
    return b > r + 25 and b > 150


def vote_skeleton(img):
    px = img.load()
    W, H = img.size
    g = [[0] * LW for _ in range(LH)]
    for gy in range(LH):
        y0, y1 = int(gy * H / LH), int((gy + 1) * H / LH)
        for gx in range(LW):
            x0, x1 = int(gx * W / LW), int((gx + 1) * W / LW)
            blue = sum(1 for yy in range(y0, y1, 2) for xx in range(x0, x1, 2) if is_blue(*px[xx, yy]))
            total = ((x1 - x0 + 1) // 2) * ((y1 - y0 + 1) // 2)
            g[gy][gx] = 1 if blue > total / 2 else 0
    # 3x3 多数平滑 2 轮
    for _ in range(2):
        ng = [row[:] for row in g]
        for y in range(LH):
            for x in range(LW):
                cnt = sum(g[y + dy][x + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                          if 0 <= y + dy < LH and 0 <= x + dx < LW)
                ng[y][x] = 1 if cnt >= 5 else 0
        g = ng
    return g


def refine(skel):
    """骨架 -> 字符网格：身体左半 b、尾巴 B、身体内空白 E（凹陷=眼睛/嘴）"""
    grid = [['.'] * LW for _ in range(LH)]
    BODY_MAX_X = 21
    for y in range(LH):
        blues = [x for x in range(LW) if skel[y][x] and x < BODY_MAX_X]
        if not blues:
            continue
        lo, hi = min(blues), max(blues)
        for x in range(lo, min(hi, BODY_MAX_X - 1) + 1):
            grid[y][x] = 'b' if skel[y][x] else 'E'
    for y in range(LH):
        for x in range(LW):
            if skel[y][x] and x >= BODY_MAX_X:
                grid[y][x] = 'B'
    return grid


def face(mode, grid):
    """表情覆盖：E 凹陷区域 -> 各状态的眼睛/嘴；腮红、喷水"""
    eye_rows = {}
    for y in range(LH):
        xs = [x for x in range(LW) if grid[y][x] == 'E']
        if xs:
            eye_rows[y] = (min(xs), max(xs))
    if not eye_rows:
        return grid
    ymin, ymax = min(eye_rows), max(eye_rows)
    for y in range(LH):
        if y not in eye_rows:
            continue
        x0, x1 = eye_rows[y]
        for x in range(x0, x1 + 1):
            if mode == 'default':
                grid[y][x] = 'K' if (x >= x1 - 1 and y in (ymin + 2, ymin + 3)) else 'w'
            elif mode == 'working':
                if y >= ymin + 3:
                    grid[y][x] = 'K' if (x >= x1 - 2 and y in (ymin + 4, ymin + 5)) else 'w'
                else:
                    grid[y][x] = 'b'
            elif mode == 'attention':
                grid[y][x] = 'K' if (x >= x1 - 2 and ymin + 2 <= y <= ymin + 5) else 'w'
            elif mode == 'done':
                if y <= ymin + 1:
                    grid[y][x] = 'K' if x in (x0, x1) else 'b'
                elif ymin + 2 <= y <= ymin + 3 and x0 + 1 <= x <= x1 - 1:
                    grid[y][x] = 'K'
                else:
                    grid[y][x] = 'b'
            elif mode == 'idle':
                grid[y][x] = 'K' if (ymin + 3 <= y <= ymin + 4 and x0 + 1 <= x <= x1 - 1) else 'b'
            elif mode == 'offline':
                mid = (x0 + x1) // 2
                top, bot = ymin + 1, ymax - 1
                if (y == top and x in (x0, x1)) or (y == mid - ymin + ymin and x == mid) or (y == bot and x in (x0, x1)):
                    grid[y][x] = 'K'
                else:
                    grid[y][x] = 'b'
    # 嘴（E 区域下方）
    if mode == 'attention':
        for y in range(ymax + 1, min(LH, ymax + 3)):
            for x in range(LW):
                if grid[y][x] == 'E':
                    grid[y][x] = 'K'
    if mode == 'done':
        y = min(LH - 1, ymax + 1)
        for x in range(LW):
            if grid[y][x] == 'E':
                grid[y][x] = 'K'
    # 腮红（眼睛左下）
    if mode not in ('offline',):
        bx, by = x0 - 2 if x0 >= 3 else 3, ymax - 1
        if by < LH and 0 <= bx < LW and grid[by][bx] == 'b':
            grid[by][bx] = 'P'
        if by + 1 < LH and grid[by + 1][bx] == 'b':
            grid[by + 1][bx] = 'P'
    # 喷水柱（头顶，仅 working/done 有 R 水柱；本脚本用水蓝色块示意）
    if mode in ('working', 'done'):
        for y in range(2, 5):
            grid[y][11] = 'R'
            grid[y][12] = 'R'
    return grid


def upscale2x(grid40):
    """40x29 -> 80x58（每像素 2x2）"""
    out = []
    for y in range(LH):
        row = grid40[y]
        row2x = ''.join(ch + ch for ch in row)
        out.append(row2x)
        out.append(row2x)
    return out


def main():
    if len(sys.argv) < 2:
        print('用法: python3 scripts/ref_to_sprites.py <参考图路径>')
        sys.exit(1)
    img = Image.open(sys.argv[1]).convert('RGB')
    skel = vote_skeleton(img)
    modes = ['default', 'working', 'attention', 'done', 'idle', 'offline']
    sprites = {}
    for m in modes:
        g = refine(skel)
        g = face(m, g)
        # 离线状态灰阶映射
        if m == 'offline':
            g = [[GRAY_MAP.get(c, c) for c in row] for row in g]
        sprites[m] = upscale2x(g)

    data = {
        'canvas': {'width': 80, 'height': 58, 'logical_display_size': [40, 29], 'background': 'transparent'},
        'palette': PALETTE,
        'sprites': sprites,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f'✅ 已生成 {OUT}（80x58，6 状态）。重启桌宠生效。')


if __name__ == '__main__':
    main()
