#!/usr/bin/env bash
# install.sh — install the fork's binaries (kimi CLI + kimi-hub) from this
# repo's GitHub Releases. The upstream one-liner installs the official CLI
# from code.kimi.com; this script installs leoleoasd's fork artifacts.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/leoleoasd/kimi-code/main/install.sh | bash
#
# Flags (passed after `bash -s` when piping):
#   --cli-only | --hub-only    install just one product
#   --install-dir <dir>        install root (default: ~/.kimi-code; binaries land in <dir>/bin)
#   --version <tag>            pin a release tag (fork-vX.Y.Z or X.Y.Z; default: latest)
#   --help                     show usage
#
# Env:
#   KIMI_FORK_REPO   (default leoleoasd/kimi-code)
#   KIMI_INSTALL_DIR (same as --install-dir)
#   KIMI_NO_MODIFY_PATH  skip the shell rc PATH edit when set
#   KIMI_FORK_RELEASES_BASE_URL  override the releases root (mirrors, tests)
set -euo pipefail

REPO="${KIMI_FORK_REPO:-leoleoasd/kimi-code}"
RELEASES_BASE="${KIMI_FORK_RELEASES_BASE_URL:-https://github.com/$REPO/releases}"
INSTALL_DIR="${KIMI_INSTALL_DIR:-$HOME/.kimi-code}"
BIN_DIR=""
VERSION="latest"
WANT_CLI=1
WANT_HUB=1

_log() { printf 'kimi-fork installer: %s\n' "$1"; }
_err() { printf 'kimi-fork installer: error: %s\n' "$1" >&2; exit 1; }
_have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
kimi-fork installer — install kimi (fork CLI) + kimi-hub from GitHub Releases.

Usage: install.sh [options]

Options:
  --cli-only         install only the kimi CLI
  --hub-only         install only kimi-hub
  --install-dir DIR  install root (default: ~/.kimi-code; binaries in DIR/bin)
  --version TAG      pin a release tag (fork-vX.Y.Z or X.Y.Z; default: latest)
  --help             show this message
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --cli-only) WANT_HUB=0 ;;
    --hub-only) WANT_CLI=0 ;;
    --install-dir) INSTALL_DIR="${2:?--install-dir needs a value}"; shift ;;
    --version) VERSION="${2:?--version needs a value}"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) _err "unknown flag: $1 (try --help)" ;;
  esac
  shift
done
BIN_DIR="$INSTALL_DIR/bin"

_have curl || _err "curl is required"

_detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux"  ;;
    MINGW*|MSYS*|CYGWIN*)
      _err "Windows is not supported by install.sh — download the win32 zip from https://github.com/$REPO/releases"
      ;;
    *) _err "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) _err "unsupported architecture: $(uname -m)" ;;
  esac

  # Rosetta 2: an x64 shell on an ARM Mac should get the native arm64 binary.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
      arch="arm64"
    fi
  fi

  # musl (Alpine etc.): only glibc binaries are published — fail early rather
  # than dying at runtime on dlopen.
  if [ "$os" = "linux" ]; then
    if [ -f "/lib/libc.musl-x86_64.so.1" ] || \
       [ -f "/lib/libc.musl-aarch64.so.1" ] || \
       ldd /bin/ls 2>&1 | grep -q musl; then
      _err "Alpine / musl Linux is not currently supported (only glibc builds are published)"
    fi
  fi

  printf '%s-%s' "$os" "$arch"
}

_download() {
  local url="$1" dest="${2:-}"
  if [ -n "$dest" ]; then
    curl --fail --location --silent --show-error -o "$dest" "$url"
  else
    curl --fail --location --silent --show-error "$url"
  fi
}

# Prefer jq; otherwise parse a single manifest field using pure bash regex.
_manifest_field() {
  local manifest_json="$1" target="$2" field="$3"
  if _have jq; then
    printf '%s' "$manifest_json" | jq -er ".platforms[\"$target\"].$field // empty"
  else
    local one_line
    one_line="$(printf '%s' "$manifest_json" | tr -d '\n\r\t' | sed 's/ \+/ /g')"
    if [[ $one_line =~ \"$target\"[^}]*\"$field\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
    fi
  fi
}

_sha256_check() {
  local file="$1" expected="$2" actual
  if _have sha256sum; then
    actual="$(sha256sum "$file" | cut -d' ' -f1)"
  elif _have shasum; then
    actual="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  else
    _err "sha256sum or shasum is required to verify the download"
  fi
  if [ "$actual" != "$expected" ]; then
    _err "checksum mismatch for $file: expected $expected, got $actual"
  fi
}

_install_binary() {
  # args: <local tmp file> <target binary path>
  local src="$1" dest="$2"
  if [ -f "$dest" ]; then
    cp "$dest" "$dest.bak"
    _log "backed up existing $(basename "$dest") to $dest.bak"
  fi
  install -m 0755 "$src" "$dest"
  _log "installed $(basename "$dest") → $dest"
}

_detect_shell_rc() {
  local shell_name
  shell_name="$(basename "${SHELL:-/bin/bash}")"
  case "$shell_name" in
    zsh)  printf '%s' "$HOME/.zshrc" ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then printf '%s' "$HOME/.bashrc"
      elif [ -f "$HOME/.bash_profile" ]; then printf '%s' "$HOME/.bash_profile"
      elif [ -f "$HOME/.profile" ]; then printf '%s' "$HOME/.profile"
      else printf '%s' "$HOME/.bashrc"; fi
      ;;
    fish) printf '%s' "$HOME/.config/fish/config.fish" ;;
    *)    printf '%s' "$HOME/.profile" ;;
  esac
}

# Legacy fallback for releases that predate the bare-binary assets: install
# from the zip (checksum sidecar plus unzip/python3 extraction).
_extract() {
  # args: <zip file> <dest dir>
  if _have unzip; then
    (cd "$2" && unzip -q -o "$1")
  elif _have python3; then
    python3 -m zipfile -e "$1" "$2"
  else
    _err "unzip (or python3 with zipfile) is required for a legacy zip install"
  fi
}

_install_zip() {
  # args: <asset base name: kimi-code|kimi-hub> <exec name in the zip>
  local name="$1" exec_name="$2" zip_file expected
  zip_file="$name-$TARGET.zip"
  _log "downloading $zip_file (legacy zip layout)…"
  _download "$BASE_URL/$zip_file" "$TMP/pkg.zip" || _err "failed to download $BASE_URL/$zip_file"
  expected="$(_download "$BASE_URL/$zip_file.sha256")"
  [ -n "$expected" ] || _err "$zip_file.sha256 is empty or unreachable at $BASE_URL"
  _sha256_check "$TMP/pkg.zip" "${expected%% *}"
  _extract "$TMP/pkg.zip" "$TMP"
  [ -f "$TMP/$exec_name" ] || _err "$exec_name not found inside $zip_file"
  _install_binary "$TMP/$exec_name" "$BIN_DIR/$exec_name"
}

_update_path() {
  if [ -n "${KIMI_NO_MODIFY_PATH:-}" ]; then
    _log "skipping PATH update (KIMI_NO_MODIFY_PATH set)"
    return
  fi
  case ":$PATH:" in
    *":$BIN_DIR:"*)
      _log "$BIN_DIR is already in PATH"
      return
      ;;
  esac
  local rc export_line
  rc="$(_detect_shell_rc)"
  mkdir -p "$(dirname "$rc")"
  if [[ "$rc" == *fish* ]]; then
    export_line="fish_add_path -g \"$BIN_DIR\""
  else
    export_line="export PATH=\"$BIN_DIR:\$PATH\""
  fi
  if ! grep -qsF "$BIN_DIR" "$rc"; then
    printf '\n# kimi-code (fork)\n%s\n' "$export_line" >> "$rc"
    _log "added $BIN_DIR to PATH in $rc — restart your shell or: source $rc"
  else
    _log "$BIN_DIR is already configured in $rc"
  fi
}

_warn_stale_binaries() {
  # Other `kimi` / `kimi-hub` copies reachable via PATH (e.g. an older
  # ~/.local/bin install) may shadow or confuse — list them with removal hints.
  local name path real stale=0
  for name in kimi kimi-hub; do
    while IFS= read -r path; do
      real="$(readlink -f "$path" 2>/dev/null || printf '%s' "$path")"
      if [ "$real" = "$(readlink -f "$BIN_DIR/$name" 2>/dev/null || printf '%s' "$BIN_DIR/$name")" ]; then
        continue
      fi
      stale=1
      printf 'kimi-fork installer: note — stale copy on PATH: %s (remove with: rm %s)\n' "$path" "$path" >&2
    done <<EOF
$(type -a -p "$name" 2>/dev/null | awk '!seen[$0]++' || true)
EOF
  done
  if [ "$stale" = 1 ]; then
    printf 'kimi-fork installer: %s/bin precedes them once PATH is updated (see above)\n' "$INSTALL_DIR" >&2
  fi
}

TARGET="$(_detect_target)"
case "$VERSION" in
  latest) BASE_URL="$RELEASES_BASE/latest/download" ;;
  fork-v*) BASE_URL="$RELEASES_BASE/download/$VERSION" ;;
  *) BASE_URL="$RELEASES_BASE/download/fork-v$VERSION" ;;
esac

mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$WANT_CLI" = 1 ]; then
  _log "fetching release manifest ($VERSION)…"
  manifest="$(_download "$BASE_URL/manifest.json" 2>/dev/null || true)"
  if [ -n "$manifest" ]; then
    filename="$(_manifest_field "$manifest" "$TARGET" "filename")"
    checksum="$(_manifest_field "$manifest" "$TARGET" "checksum")"
    [ -n "$filename" ] || _err "platform $TARGET not found in the release manifest"
    [ -n "$checksum" ] || _err "manifest has no checksum for $TARGET"
    _log "downloading $filename ($TARGET)…"
    _download "$BASE_URL/$filename" "$TMP/kimi"
    _sha256_check "$TMP/kimi" "$checksum"
    _install_binary "$TMP/kimi" "$BIN_DIR/kimi"
  else
    _log "no manifest.json on this release — falling back to the zip layout"
    _install_zip kimi-code kimi
  fi
fi

if [ "$WANT_HUB" = 1 ]; then
  hub_name="kimi-hub-$TARGET"
  _log "downloading ${hub_name}…"
  if _download "$BASE_URL/$hub_name" "$TMP/kimi-hub" 2>/dev/null; then
    expected="$(_download "$BASE_URL/$hub_name.sha256")"
    [ -n "$expected" ] || _err "$hub_name.sha256 is empty or unreachable at $BASE_URL"
    _sha256_check "$TMP/kimi-hub" "${expected%% *}"
    _install_binary "$TMP/kimi-hub" "$BIN_DIR/kimi-hub"
  else
    _log "no bare $hub_name on this release — falling back to the zip layout"
    _install_zip kimi-hub kimi-hub
  fi
fi
rm -rf "$TMP"
trap - EXIT

_update_path
_warn_stale_binaries
_log "done — try: kimi --version$([ "$WANT_HUB" = 1 ] && printf ', kimi-hub')"
