#!/bin/bash
# ============================================================
# DSH 桌宠一键发布：提交代码 -> 推送 GitHub -> 重新打包 -> 发 Release
# 用法: bash scripts/publish.sh [版本号]
#   - 不带参数：版本号取 package.json 的 version，tag 为 v<version>
#   - 带参数：如 bash scripts/publish.sh 0.2.0
#   - 推送目标默认 personal（公开源），可用 REMOTE=origin 覆盖
# 前置：pnpm install 已装依赖；gh 已登录；代码在 git 仓库内
# ============================================================
set -e
cd "$(dirname "$0")/.."

# 1. 版本号
if [ -n "$1" ]; then
  VERSION="$1"
  node -e "const p=require('./package.json');p.version='$VERSION';require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n')"
else
  VERSION=$(node -p "require('./package.json').version")
fi
TAG="v$VERSION"
echo "🔖 发布版本: $TAG"

# 2. 提交并推送（默认推到 personal 公开源，而非旧的 origin/dsh-external）
REMOTE="${REMOTE:-personal}"
REPO="$(git config "remote.$REMOTE.url" | sed -E 's#^[^:]*[:/]##; s#\.git$##')"
echo "📡 推送目标: $REMOTE ($REPO)"
git add -A
git commit -m "release: $TAG" 2>/dev/null || echo "（无代码变更，跳过提交）"
git push "$REMOTE" main
echo "✅ 代码已推送"

# 3. 打包
echo "📦 打包中..."
pnpm dist
echo "✅ 打包完成"

# 4. 发 Release
DMG=$(ls dist/*.dmg 2>/dev/null | head -1)
ZIP=$(ls dist/*-mac.zip 2>/dev/null | head -1)
[ -z "$DMG" ] && { echo "❌ 未找到 dmg 产物"; exit 1; }
ASSETS=("$DMG")
[ -n "$ZIP" ] && ASSETS+=("$ZIP")

gh release create "$TAG" "${ASSETS[@]}" -R "$REPO" --title "$TAG" \
  --notes "**DSH 桌宠 $TAG**：见 CHANGELOG.md 了解本次变更。" || \
  gh release create "$TAG" "${ASSETS[@]}" -R "$REPO" --title "$TAG" --notes "覆盖发布 $TAG" 2>/dev/null || true
echo "✅ Release 已发布: https://github.com/$REPO/releases/tag/$TAG"
echo "🎉 完成！hub 索引将在 2 小时内自动刷新。"
