#!/usr/bin/env python3
"""从像素鲸鱼素材生成应用图标（icon.png + icon.icns）。

用法: python3 scripts/gen_icon.py
输出: assets/icon.png (1024) + assets/icon.icns (macOS)
"""
import os
import subprocess
from PIL import Image

BASE = os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(BASE, 'pixel-src-hd', 'default.png')
OUT_DIR = os.path.join(BASE, 'assets')

SIZES = 1024  # 主图标尺寸


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    img = Image.open(SRC).convert('RGBA')
    w, h = img.size
    # 等比放大到 90% 画布并居中（像素风用 NEAREST 保持锐利格子）
    scale = SIZES * 0.9 / max(w, h)
    nw, nh = int(w * scale), int(h * scale)
    big = img.resize((nw, nh), Image.NEAREST)
    canvas = Image.new('RGBA', (SIZES, SIZES), (0, 0, 0, 0))
    canvas.paste(big, ((SIZES - nw) // 2, (SIZES - nh) // 2), big)
    png_path = os.path.join(OUT_DIR, 'icon.png')
    canvas.save(png_path)
    print(f'✅ {png_path} ({canvas.size})')

    # macOS iconset -> icns
    icns_path = os.path.join(OUT_DIR, 'icon.icns')
    if os.path.exists(icns_path):
        os.remove(icns_path)
    iconset = os.path.join(OUT_DIR, 'icon.iconset')
    os.makedirs(iconset, exist_ok=True)
    specs = {
        'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
        'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
        'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
        'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
        'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
    }
    for name, size in specs.items():
        im = canvas.resize((size, size), Image.NEAREST)
        im.save(os.path.join(iconset, name))
    r = subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', icns_path],
                       capture_output=True, text=True)
    if r.returncode == 0 and os.path.exists(icns_path):
        print(f'✅ {icns_path}')
    else:
        print(f'⚠️ iconutil 失败（不影响 png 图标）: {r.stderr[:200]}')
    # 清理 iconset
    subprocess.run(['rm', '-rf', iconset])


if __name__ == '__main__':
    main()
