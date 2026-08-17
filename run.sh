#!/bin/bash
# ============================================================
# DSH 桌宠启动器：双击运行 或 终端执行 ./run.sh
# 桌宠会保持运行直到你退出（右键鲸鱼 -> 退出桌宠 / Ctrl+C）
# ============================================================
cd "$(dirname "$0")"

# 已运行的实例直接提示（单实例锁；匹配 pnpm/npm 任意 Electron 版本布局）
if pgrep -f "dsh-pet.*Electron\.app/Contents/MacOS/Electron" > /dev/null; then
  echo "🐋 桌宠已在运行中（右下角应该能看到它）"
  exit 0
fi

echo "🐋 启动 DSH 桌宠..."
pnpm start
