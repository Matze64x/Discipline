#!/bin/sh
# Packs the portable Linux version after `npm run tauri build`: the program plus an empty
# `Discipline-data` folder next to it, which makes the app keep all its data there (see
# src-tauri/src/data_dir.rs). It uses the system's WebKitGTK 4.1 (package webkit2gtk-4.1 on Arch,
# libwebkit2gtk-4.1-0 on Debian/Ubuntu). Writes src-tauri/target/release/bundle/portable/*.tar.gz.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
bundle=src-tauri/target/release/bundle
name="Discipline_${version}_amd64-portable"
rm -rf "$bundle/portable/$name"
mkdir -p "$bundle/portable/$name/Discipline-data"
cp src-tauri/target/release/discipline "$bundle/portable/$name/Discipline"
cp scripts/portable-readme.txt "$bundle/portable/$name/Discipline-data/README.txt"
tar --owner=0 --group=0 --numeric-owner -czf "$bundle/portable/$name.tar.gz" -C "$bundle/portable" "$name"
echo "$bundle/portable/$name.tar.gz"
