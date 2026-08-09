#!/usr/bin/env python3
"""像素版验证：按 26x21 网格坐标校验每个状态的关键像素。"""
import os
from PIL import Image

SHOTS = os.path.join(os.path.dirname(__file__), "..", ".shots")
# canvas 物理位置：stage 左上(18,248) + canvas 居中偏移(2,2) => (20,250)；每格 20px（2x Retina，canvas 内部已 2x）
CX, CY, S = 20, 250, 20
COLORS = {
    'b': (0x4D, 0x6B, 0xFE), 'B': (0x2E, 0x46, 0xD0), 'W': (0xDC, 0xE4, 0xFF),
    'w': (0xFF, 0xFF, 0xFF), 'K': (0x0F, 0x1B, 0x4D), 'P': (0xFF, 0x9E, 0xBB),
    'R': (0x8F, 0xB0, 0xFF),
    'g': (0x9A, 0xA3, 0xB8),  # 离线灰(GRAY.b)
    'Bg': (0x6E, 0x76, 0x90),  # 离线灰(GRAY.B)
    'Kg': (0x3A, 0x41, 0x54),  # 离线灰(GRAY.K)
}

def cell(px, col, row):
    return px[CX + col * S + S // 2, CY + row * S + S // 2][:3]

def near(c1, c2, tol=35):
    return all(abs(a - b) <= tol for a, b in zip(c1, c2))

def check(name, expects):
    img = Image.open(f"{SHOTS}/{name}").convert("RGB")
    px = img.load()
    ok = True
    print(f"===== {name} =====")
    for label, col, row, key in expects:
        got = cell(px, col, row)
        target = COLORS[key]
        good = near(got, target)
        ok &= good
        print(f"  {'✅' if good else '❌'} {label} @({col},{row}) = {got} (期望 {target})")
    return ok

all_ok = True

# default 身体特征（用 idle 验证，身体结构相同）
all_ok &= check("pixel-idle.png", [
    ("身体亮蓝", 13, 12, 'b'),
    ("尾巴深蓝", 21, 1, 'B'),
    ("肚皮", 12, 15, 'W'),
    ("闭眼线(睡觉)", 7, 10, 'K'),
    ("腮红", 10, 12, 'P'),
])

all_ok &= check("pixel-working.png", [
    ("身体亮蓝", 13, 12, 'b'),
    ("喷水柱", 14, 2, 'R'),
    ("眉毛", 6, 8, 'B'),
    ("半睁眼(眼白)", 6, 10, 'w'),
    ("半睁眼(瞳孔)", 7, 10, 'K'),
])

all_ok &= check("pixel-attention.png", [
    ("身体亮蓝", 13, 12, 'b'),
    ("眼白", 6, 9, 'w'),
    ("大瞳孔", 8, 10, 'K'),
    ("张嘴", 9, 12, 'K'),
    ("八字眉", 5, 8, 'B'),
])

all_ok &= check("pixel-done.png", [
    ("身体亮蓝", 13, 12, 'b'),
    ("^^眼左", 6, 9, 'K'),
    ("^^眼右", 8, 9, 'K'),
    ("微笑嘴", 9, 13, 'K'),
    ("腮红", 10, 12, 'P'),
])

all_ok &= check("pixel-offline.png", [
    ("身体灰度", 13, 12, 'g'),
    ("尾巴灰度", 21, 1, 'Bg'),
    ("X眼左上", 6, 9, 'Kg'),
    ("X眼右下", 8, 11, 'Kg'),
])

print("\nALL PASS" if all_ok else "\nSOME CHECKS FAILED")
