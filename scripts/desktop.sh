#!/bin/sh
# The desktop app on Linux in one place (run from anywhere):
#
#   sh scripts/desktop.sh build       builds the program (src-tauri/target/release/discipline)
#   sh scripts/desktop.sh test        all tests: web app (types, unit, Firefox and WebKit in Docker)
#                                         and Rust (tests, clippy); Docker must be running
#   sh scripts/desktop.sh install     builds it, then installs it for you: program in ~/.local/bin,
#                                         menu entry and icons (no root rights); also updates it
#   sh scripts/desktop.sh uninstall   removes the installed program (your data stays)
#   sh scripts/desktop.sh packages    the packages to share: installer (.sh), .deb and portable
#                                         .tar.gz in src-tauri/target/release/bundle/
set -eu
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$self")/.."

dependencies() {
	[ -d node_modules ] || npm ci
}

build() {
	dependencies
	npm run tauri build -- --no-bundle
}

case "${1:-}" in
build)
	build
	;;
test)
	dependencies
	npm run test:all
	# (the Rust build embeds the built web app)
	npm run build
	(cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings)
	;;
install)
	build
	installer=$(sh scripts/package-installer.sh | tail -n 1)
	sh "$installer"
	;;
uninstall)
	# (the installer's own uninstall; it needs nothing of the build)
	sh scripts/linux-installer-stub.sh --uninstall
	;;
packages)
	dependencies
	npm run tauri build -- --bundles deb
	sh scripts/package-portable.sh
	sh scripts/package-installer.sh
	;;
*)
	sed -n '2,12p' "$self" | sed 's/^# \{0,1\}//'
	exit 1
	;;
esac
