#!/bin/zsh

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR" || exit 1

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

echo "ComfyUI H3 Dual Mode Director for macOS"
echo "========================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js was not found."
  echo "Install Node.js LTS, or run: brew install node"
  echo "Then open this file again."
  read -r "?Press Return to close..."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm was not found. Reinstall Node.js LTS."
  read -r "?Press Return to close..."
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "[NOTICE] Codex CLI was not found."
  echo "Install it with: npm install -g @openai/codex"
  echo "Then run codex once and sign in with ChatGPT."
else
  echo "[OK] Codex CLI: $(command -v codex)"
fi

echo "[OK] Node.js: $(node --version)"
echo "Opening http://127.0.0.1:3030 ..."
(sleep 2; open "http://127.0.0.1:3030" >/dev/null 2>&1) &

npm start
EXIT_CODE=$?

echo ""
echo "Runner stopped with exit code $EXIT_CODE."
read -r "?Press Return to close..."
exit "$EXIT_CODE"
