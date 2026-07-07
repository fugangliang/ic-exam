#!/bin/zsh
# アプリを GitHub Pages にデプロイする。
# 使い方: scripts/deploy.sh
# main を push し、app/ を gh-pages ブランチとして切り出して push する。
set -e
cd "$(dirname "$0")/.."

node scripts/test_logic.js
for f in app/*.js; do node --check "$f"; done

if [ -n "$(git status --porcelain)" ]; then
  echo "未コミットの変更があります。先にコミットしてください:" >&2
  git status --short >&2
  exit 1
fi

git push origin main
git branch -f gh-pages "$(git subtree split --prefix app)"
git push -f origin gh-pages
echo "デプロイ完了: https://fugangliang.github.io/ic-exam/"
echo "反映まで1〜2分。iPhone側はアプリを一度オンラインで開き直すと更新される（sw.jsのVERSIONを上げた場合）"
