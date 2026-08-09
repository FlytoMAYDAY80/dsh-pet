#!/usr/bin/env python3
"""像素级自检（Retina 2x）：验证桌宠各状态截图的关键渲染点。"""
import os
import sys
from PIL import Image

SHOTS = os.path.join(os.path.dirname(__file__), "..", ".shots")
# 逻辑窗口 280x340；截图 560x680（DPR=2）
DPR = 2
# stage 逻辑: left 9, top 124, w 262, h 212；SVG 均匀缩放 1.06，内容水平居中偏移 3.8
STAGE_X = 9 * DPR
STAGE_Y = 124 * DPR
S = 2.12  # svg 单位 -> 物理像素
OFFX = 3.8 * DPR

def svg(sx, sy):
    return (int(STAGE_X + OFFX + sx * S), int(STAGE_Y + sy * S))

def near(c1, c2, tol=30):
    return all(abs(a - b) <= tol for a, b in zip(c1, c2))

def count_near(img, target, region, tol=40):
    x0, y0, x1, y1 = region
    n = 0
    px = img.load()
    for y in range(y0, min(y1, img.height)):
        for x in range(x0, min(x1, img.width)):
            if near(px[x, y][:3], target, tol):
                n += 1
    return n

def analyze(name):
    img = Image.open(f"{SHOTS}/{name}").convert("RGB")
    px = img.load()
    results = []

    bg = px[20, 20][:3]
    results.append(("背景色", "浅蓝白" if near(bg, (0xF3, 0xF6, 0xFF), 12) else f"异常{bg}"))

    bub = px[140 * DPR, 38 * DPR][:3]
    results.append(("气泡底色", "深藏青" if near(bub, (0x0E, 0x1A, 0x4E), 30) else f"异常{bub}"))

    bx, by = svg(140, 80)  # 身体蓝色区（避开肚皮）
    body = px[bx, by][:3]
    is_blue = near(body, (0x5B, 0x7B, 0xFF), 50) or near(body, (0x3B, 0x52, 0xE8), 50)
    if "offline.png" in name:
        gray = max(body) - min(body) < 45
        results.append(("鲸鱼身体色(灰)", "OK" if gray else f"未变灰{body}"))
    else:
        results.append(("鲸鱼身体色", "深蓝" if is_blue else f"异常{body}@{bx},{by}"))

    ex, ey = svg(78, 88)
    eye = px[ex, ey][:3]
    if not any(x in name for x in ("done.png", "idle.png")):
        results.append(("瞳孔/表情中心", "深色" if sum(eye) < 200 else f"异常{eye}"))

    ux, uy = svg(74, 76)
    eye_top = px[ux, uy][:3]
    if "working.png" in name:
        ok = near(eye_top, (0x3B, 0x52, 0xE8), 45)
        results.append(("眼睑(working)", "蓝眼睑" if ok else f"异常{eye_top}"))
    elif any(x in name for x in ("done.png", "idle.png")):
        # 完成=开心弧线 / 空闲=睡觉线：眼区应有深色表情线条
        x0, y0 = svg(52, 80)
        x1, y1 = svg(100, 96)
        n = count_near(img, (0x10, 0x20, 0x5E), (x0, y0, x1, y1), tol=70)
        label = "开心弧线" if "done.png" in name else "睡觉线"
        results.append((f"{label}", f"OK({n}px)" if n > 10 else f"缺({n}px)"))
    elif "offline.png" in name:
        g = eye_top
        gray = max(g) - min(g) < 45
        results.append(("眼(离线灰)", "OK" if gray else f"未变灰{g}"))
    else:
        ok = near(eye_top, (0xFF, 0xFF, 0xFF), 30)
        results.append(("眼白", "白色" if ok else f"异常{eye_top}"))

    # 徽标：stage 逻辑右上 (right:14, top:6)，22x22 逻辑
    badge_box = (STAGE_X + (262 - 14 - 22 - 10) * DPR, STAGE_Y + 6 * DPR, STAGE_X + (262 - 14 + 10) * DPR, STAGE_Y + (6 + 22 + 10) * DPR)
    if "attention.png" in name:
        n = count_near(img, (0xFF, 0x4D, 0x5E), badge_box, tol=60)
        results.append(("红徽标", f"OK({n}px)" if n > 30 else f"缺({n}px)"))
    elif "done.png" in name:
        n = count_near(img, (0x22, 0xB5, 0x73), badge_box, tol=60)
        results.append(("绿徽标", f"OK({n}px)" if n > 30 else f"缺({n}px)"))
    elif "working.png" in name:
        n = count_near(img, (0x3B, 0x6B, 0xFF), badge_box, tol=60)
        results.append(("蓝徽标", f"OK({n}px)" if n > 30 else f"缺({n}px)"))

    if "offline.png" in name:
        g = px[bx, by][:3]
        gray = max(g) - min(g) < 45
        results.append(("离线灰度", "OK" if gray else f"未变灰{g}"))

    if "done.png" in name:
        # 星星是动画元素，透明度 0.4~1 变化；用"黄白混合"特征检测（对低透明度帧也敏感）
        x0, y0, x1, y1 = (20 * DPR, 300, 260 * DPR, 600)
        n = 0
        px2 = img.load()
        for yy in range(y0, min(y1, img.height)):
            for xx in range(x0, min(x1, img.width)):
                r, g, b = px2[xx, yy][:3]
                if r > 210 and g > 190 and b < 215:
                    n += 1
        results.append(("星星闪烁", f"OK({n}px)" if n > 8 else f"缺({n}px)"))

    if "idle.png" in name:
        n = count_near(img, (0x3B, 0x52, 0xE8), (60 * DPR, 190, 220 * DPR, 340), tol=45)
        results.append(("zzz 文字", f"OK({n}px)" if n > 8 else f"缺({n}px)"))

    return results

if __name__ == "__main__":
    ok_all = True
    for base in ["working", "attention", "done", "idle", "offline"]:
        name = "vector-" + base + ".png"
        print(f"===== {name} =====")
        for label, msg in analyze(name):
            flag = "✅" if not msg.startswith(("异常", "缺", "未变灰")) else "❌"
            if flag == "❌":
                ok_all = False
            print(f"  {flag} {label}: {msg}")
    print("\nALL PASS" if ok_all else "\nSOME CHECKS FAILED")
