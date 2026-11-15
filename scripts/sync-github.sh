#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

COMMIT_MSG="${1:-feat: update AI Image-to-Video Studio}"

echo "Staging changes..."
git add .

if git diff --cached --quiet; then
  echo "No new file changes to commit."
else
  git commit -m "$COMMIT_MSG"
fi

echo "Pushing to origin main (https://github.com/abhishekjais-124/ai-image-to-video.git)..."
git push -u origin main
echo "Successfully pushed to GitHub!"
