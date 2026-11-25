#!/bin/sh
# Packs the Linux installer after `npm run tauri build`: one shell script (linux-installer-stub.sh)
# with the program and its icons appended, which installs Discipline for the current user (program,
# menu entry, icons; no root rights). Writes src-tauri/target/release/bundle/installer/*.sh.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
bundle=src-tauri/target/release/bundle
payload=$(mktemp -d)
trap 'rm -rf "$payload"' EXIT
cp src-tauri/target/release/discipline "$payload/discipline"
cp src-tauri/icons/32x32.png "$payload/32x32.png"
cp src-tauri/icons/128x128.png "$payload/128x128.png"
cp src-tauri/icons/128x128@2x.png "$payload/256x256.png"
out="$bundle/installer/Discipline_${version}_amd64-install.sh"
mkdir -p "$bundle/installer"
cp scripts/linux-installer-stub.sh "$out"
tar --owner=0 --group=0 --numeric-owner -czf - -C "$payload" . >>"$out"
chmod 755 "$out"
echo "$out"
