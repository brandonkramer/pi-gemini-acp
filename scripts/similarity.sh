#!/usr/bin/env bash
set -euo pipefail
VERSION="v0.5.0"
DEST=".bin"
mkdir -p "$DEST"
[ -x "$DEST/similarity-ts" ] && exit 0

case "$(uname -s)-$(uname -m)" in
Darwin-arm64) ASSET="similarity-${VERSION}-aarch64-apple-darwin.tar.gz" ;;
Linux-x86_64) ASSET="similarity-${VERSION}-x86_64-unknown-linux-gnu.tar.gz" ;;
*)
	echo "No prebuilt binary for $(uname -s)-$(uname -m); run: cargo install similarity-ts --version ${VERSION#v}"
	exit 1
	;;
esac

URL="https://github.com/mizchi/similarity/releases/download/${VERSION}/${ASSET}"
curl -fsSL "$URL" | tar -xz -C "$DEST" --strip-components=1
chmod +x "$DEST/similarity-ts"
"$DEST/similarity-ts" --version
