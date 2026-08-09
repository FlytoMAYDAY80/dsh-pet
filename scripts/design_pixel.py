#!/usr/bin/env python3
"""像素鲸鱼设计预览：支持多 sprite + 行宽校验。用法: python3 design_pixel.py <<'EOF'
default:
<26字符行>
...
working:
...
EOF"""
import sys
import re

PAL = {
    '.': None,
    'b': '\033[48;5;69m',    # 亮蓝
    'B': '\033[48;5;26m',    # 深蓝
    'W': '\033[48;5;189m',   # 肚皮
    'w': '\033[48;5;255m',   # 白
    'K': '\033[48;5;17m',    # 深瞳
    'P': '\033[48;5;218m',   # 粉
    'R': '\033[48;5;111m',   # 水蓝
    'G': '\033[48;5;250m',   # 灰
}
RESET = '\033[0m'
WIDTH = 26

def preview(name, grid):
    # 行宽校验
    for i, row in enumerate(grid):
        if len(row) != WIDTH:
            print(f"!! {name} row{i} 宽 {len(row)} != {WIDTH}: {row!r}")
    print(f"\n===== {name} ({WIDTH}x{len(grid)}) =====")
    for row in grid:
        line = ''
        for ch in row:
            if ch in PAL and PAL[ch]:
                line += PAL[ch] + '  ' + RESET
            else:
                line += '  '
        print(line)
    print('-' * (WIDTH + 2))
    for row in grid:
        print(' ' + ' '.join(row))

def main():
    text = sys.stdin.read()
    blocks = re.split(r'^([a-zA-Z0-9_-]+):\s*$', text, flags=re.M)
    # blocks: ['', 'default', '...lines...', 'working', '...']
    for i in range(1, len(blocks), 2):
        name = blocks[i].strip()
        body = blocks[i + 1]
        grid = [l.rstrip('\n') for l in body.splitlines() if l.strip()]
        preview(name, grid)

if __name__ == '__main__':
    main()
