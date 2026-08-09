#!/usr/bin/env python3
"""Codex 像素素材校验：
1. PNG 技术规格（40x29 RGBA 透明）
2. 骨架与参考图投票结果的一致率
用法: python3 scripts/verify_pixel_src.py
"""
import json
import os
from PIL import Image

BASE = os.path.join(os.path.dirname(__file__), '..', 'pixel-src-hd')
REF = os.path.join(os.path.dirname(__file__), '..', 'reference whale.png')
STATES = ["default", "working", "attention", "done", "idle", "offline"]
W, H = 80, 58  # PNG 原始尺寸（HD）
LW, LH = 40, 29  # 逻辑比较尺寸
SW, SH = 640, 464


def is_blue(r, g, b):
    return b > r + 25 and b > 150


def vote_skeleton():
    img = Image.open(REF).convert('RGB')
    px = img.load()
    g = [[0] * LW for _ in range(LH)]
    for gy in range(LH):
        y0, y1 = int(gy * SH / LH), int((gy + 1) * SH / LH)
        for gx in range(LW):
            x0, x1 = int(gx * SW / LW), int((gx + 1) * SW / LW)
            blue = sum(1 for yy in range(y0, y1, 2) for xx in range(x0, x1, 2) if is_blue(*px[xx, yy]))
            total = ((x1 - x0 + 1) // 2) * ((y1 - y0 + 1) // 2)
            g[gy][gx] = 1 if blue > total / 2 else 0
    return g


def main():
    ok = True
    ref = vote_skeleton()
    for name in STATES:
        p = os.path.join(BASE, f"{name}.png")
        img = Image.open(p)
        if img.size != (W, H) or img.mode != "RGBA":
            print(f"❌ {name}: 尺寸/模式不符 {img.size} {img.mode}")
            ok = False
            continue
        a = img.getchannel("A")
        pa = a.load()
        px = img.load()
        transparent = all(px[x, y][3] == 0 for x, y in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)])
        # HD PNG -> 2x2 降采样到 40x29，按"蓝色区域"与参考图投票比较（眼睛是白色，不算蓝）
        def cell_is_blue(c):
            r, g, b, *_ = c
            return b > r + 25 and b > 150
        match = 0
        for gy in range(LH):
            for gx in range(LW):
                cnt = sum(1 for dy in (0, 1) for dx in (0, 1) if cell_is_blue(px[gx * 2 + dx, gy * 2 + dy]))
                mine = 1 if cnt >= 2 else 0
                if mine == ref[gy][gx]:
                    match += 1
        rate = match / (LW * LH) * 100
        print(f"{'✅' if transparent and rate > 92 else '❌'} {name}: {img.size} {img.mode} 透明={transparent} 蓝色区域一致率={rate:.1f}%")
        ok = ok and transparent and rate > 92
    # 修正点专项检查
    img = Image.open(os.path.join(BASE, "default.png"))
    px = img.load()
    opaque_white = sum(1 for y in range(H) for x in range(W) if px[x, y] == (255, 255, 255, 255))
    print(f"{'✅' if opaque_white > 200 else '❌'} default 嘴部/眼睛不透明白像素: {opaque_white}")
    ok = ok and opaque_white > 200

    img = Image.open(os.path.join(BASE, "offline.png"))
    px = img.load()
    light_gray = sum(1 for y in range(H) for x in range(W) if px[x, y][:3] == (240, 242, 247) and px[x, y][3] > 200)
    print(f"{'✅' if light_gray > 100 else '❌'} offline 嘴部浅灰 #F0F2F7: {light_gray}")
    ok = ok and light_gray > 100

    img = Image.open(os.path.join(BASE, "working.png"))
    px = img.load()
    r_cols = set()
    for y in range(H):
        for x in range(W):
            r, g, b, a = px[x, y]
            if abs(r - 143) < 15 and abs(g - 176) < 15 and abs(b - 255) < 15 and a > 200:
                r_cols.add(x)
    wide = (max(r_cols) - min(r_cols)) > 14 if r_cols else False
    print(f"{'✅' if wide else '❌'} working 水花双侧展开(列宽 {max(r_cols)-min(r_cols)+1 if r_cols else 0}): ")
    ok = ok and wide

    print("\nALL PASS" if ok else "\nSOME CHECKS FAILED")


if __name__ == '__main__':
    main()
