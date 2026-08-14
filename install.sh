#!/usr/bin/env bash
# install.sh — install the fork's binaries (kimi CLI + kimi-hub) from this
# repo's GitHub Releases. The upstream one-liner installs the official CLI
# from code.kimi.com; this script installs leoleoasd's fork artifacts.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/leoleoasd/kimi-code/main/install.sh | bash
# Flags (before the pipe, via bash -s):
#   --cli-only | --hub-only       install just one product
#   --install-dir <dir>           override the binary dir (default: ~/.local/bin)
#   --version <tag>               pin a release tag (default: latest)
# Env: KIMI_FORK_REPO (default leoleoasd/kimi-code), KIMI_INSTALL_DIR.
set -euo pipefail

REPO="${KIMI_FORK_REPO:-leoleoasd/kimi-code}"
INSTALL_DIR="${KIMI_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="latest"
WANT_CLI=1
WANT_HUB=1

while [ $# -gt 0 ]; do
  case "$1" in
    --cli-only) WANT_HUB=0 ;;
    --hub-only) WANT_CLI=0 ;;
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --version) VERSION="$2"; shift ;;
    *) echo "install.sh: unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "install.sh: missing required command: $1" >&2
    exit 1
  fi
}
need curl
if ! command -v unzip >/dev/null 2>&1; then
  if command -v python3 >/dev/null 2>&1; then
    EXTRACT=(python3 -m zipfile -e)
  else
    echo "install.sh: missing required command: unzip (or python3 with zipfile)" >&2
    exit 1
  fi
else
  EXTRACT=(unzip -q -o)
fi

# OS/arch → the <target> triple used in the release asset names.
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "install.sh: unsupported OS: $(uname -s) (on Windows use WSL)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "install.sh: unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
TARGET="$os-$arch"

if [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/$REPO/releases/latest/download"
else
  BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
fi

sha256_check() {
  # args: <file> <expected "<hash>  <name>">
  local file="$1" expected="$2" actual
  actual="$(sha256sum "$file" 2>/dev/null || shasum -a 256 "$file")"
  actual="${actual%% *}"
  if [ "$actual" != "${expected%% *}" ]; then
    echo "install.sh: checksum mismatch for $file" >&2
    exit 1
  fi
}

install_zip() {
  # args: <zip-name-base, e.g. kimi-code or kimi-hub> <exec name inside the zip>
  local name="$1" exec_name="$2" tmp zip_file
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  zip_file="$name-$TARGET.zip"
  echo "install.sh: downloading $zip_file ($VERSION)…"
  curl -fsSL "$BASE_URL/$zip_file" -o "$tmp/$zip_file"
  expected="$(curl -fsSL "$BASE_URL/$zip_file.sha256")"
  sha256_check "$tmp/$zip_file" "$expected"
  if [ "${EXTRACT[0]}" = "unzip" ]; then
    (cd "$tmp" && unzip -q -o "$zip_file")
  else
    python3 -m zipfile -e "$tmp/$zip_file" "$tmp"
  fi
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$tmp/$exec_name" "$INSTALL_DIR/$exec_name"
  echo "install.sh: installed $exec_name → $INSTALL_DIR/$exec_name"
  rm -rf "$tmp"
  trap - RETURN
}

if [ "$WANT_CLI" -eq 1 ]; then install_zip kimi-code kimi; fi
if [ "$WANT_HUB" -eq 1 ]; then install_zip kimi-hub kimi-hub; fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "install.sh: note — $INSTALL_DIR is not on your PATH" ;;
esac
echo "install.sh: done. Try: kimi, or run a hub with: kimi-hub"
