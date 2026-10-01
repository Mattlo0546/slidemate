#!/bin/bash
# SlideMate installer: dependencies + build + install the app.
#   curl -fsSL https://raw.githubusercontent.com/<you>/slidemate/main/scripts/install.sh | bash
#   or, from a clone:  scripts/install.sh
set -euo pipefail
bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok() { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }

[ "$(uname)" = "Darwin" ] || { echo "SlideMate is a macOS app."; exit 1; }

# Running via curl | bash: clone into ~/SlideMate-src first.
if [ ! -f "$(dirname "$0")/build-app.sh" ]; then
  SRC="$HOME/.slidemate-src"
  bold "Downloading SlideMate…"
  rm -rf "$SRC" && git clone --depth 1 "${SLIDEMATE_REPO:-https://github.com/Mattlo0546/slidemate.git}" "$SRC"
  exec bash "$SRC/scripts/install.sh"
fi
cd "$(dirname "$0")/.."

bold "1/4  Developer tools"
if xcode-select -p >/dev/null 2>&1; then ok "Xcode Command Line Tools"; else
  warn "Installing Xcode Command Line Tools (a window will open; re-run this script when it finishes)"
  xcode-select --install || true; exit 1
fi

bold "2/4  Homebrew packages"
if ! command -v brew >/dev/null; then
  warn "Homebrew not found. Install it from https://brew.sh, then re-run this script."; exit 1
fi
brew install poppler ffmpeg uv >/dev/null && ok "poppler (PDF text), ffmpeg (audio), uv"

bold "3/4  Speech-to-text for lecture recording"
if [ "$(uname -m)" = "arm64" ]; then
  uv tool install --quiet parakeet-mlx 2>/dev/null || uv tool upgrade --quiet parakeet-mlx || true
  command -v parakeet-mlx >/dev/null || export PATH="$HOME/.local/bin:$PATH"
  ok "parakeet-mlx (NVIDIA Parakeet on Apple Silicon; the model downloads on first use, ~1-2 GB)"
else
  warn "Lecture recording needs Apple Silicon; everything else works on Intel Macs."
fi

bold "4/4  Building SlideMate.app"
scripts/build-app.sh --install

echo
bold "AI tutor: SlideMate uses an AI app you're signed in to (no API keys)."
if command -v claude >/dev/null; then ok "Claude Code found"; else
  echo "  • Claude:  curl -fsSL https://claude.ai/install.sh | bash   then: claude auth login"; fi
if command -v codex >/dev/null; then ok "Codex CLI found"; else
  echo "  • ChatGPT: brew install codex   then: codex login"; fi
echo
bold "Done! Open SlideMate from Applications (first launch: right-click → Open)."
