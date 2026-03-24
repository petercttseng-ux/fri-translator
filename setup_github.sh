#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# 水試所多國語音轉譯小幫手 - GitHub 自動部署腳本
# 使用方法：
#   chmod +x setup_github.sh
#   ./setup_github.sh https://github.com/YOUR_USERNAME/fri-translator.git
# ═══════════════════════════════════════════════════════════

set -e

REPO_URL="${1}"

if [ -z "$REPO_URL" ]; then
  echo "❌ 請提供 GitHub 儲存庫 URL"
  echo "   用法: ./setup_github.sh https://github.com/USER/REPO.git"
  exit 1
fi

echo "════════════════════════════════════════"
echo "  水試所多國語音轉譯小幫手 - GitHub 部署"
echo "════════════════════════════════════════"

# Init git if needed
if [ ! -d ".git" ]; then
  echo "➤ 初始化 Git 倉庫..."
  git init
  git branch -M main
fi

# Set remote
if git remote get-url origin &>/dev/null; then
  git remote set-url origin "$REPO_URL"
  echo "➤ 更新 Remote: $REPO_URL"
else
  git remote add origin "$REPO_URL"
  echo "➤ 新增 Remote: $REPO_URL"
fi

# Stage all files
echo "➤ 加入所有檔案..."
git add .

# Commit
COMMIT_MSG="🐟 初始部署：水試所多國語音轉譯小幫手 $(date '+%Y-%m-%d %H:%M')"
git commit -m "$COMMIT_MSG" || echo "（無新變更）"

# Push
echo "➤ 推送至 GitHub..."
git push -u origin main

echo ""
echo "✅ 部署完成！"
echo "   儲存庫：$REPO_URL"
echo ""
echo "📋 後續步驟："
echo "   1. 前往 render.com 或 railway.app 連接此倉庫"
echo "   2. 設定環境變數：SECRET_KEY=<隨機字串>"
echo "   3. 啟動指令已設定於 Procfile"
echo "════════════════════════════════════════"
