#!/bin/sh
# Discipline for Linux: installs the app for the current user, without root rights:
#   program        ~/.local/bin/discipline
#   menu entry     ~/.local/share/applications/discipline.desktop
#   icons          ~/.local/share/icons/hicolor/*/apps/discipline.png
# Running it again updates Discipline. Your data stays where it is (~/.local/share/matze64x.discipline).
#
#   sh Discipline_…_amd64-install.sh               install or update
#   sh Discipline_…_amd64-install.sh --uninstall   remove the program (not your data)
#
# The app uses the system's WebKitGTK 4.1 (Arch: webkit2gtk-4.1, Debian/Ubuntu: libwebkit2gtk-4.1-0).
set -eu

share="${XDG_DATA_HOME:-$HOME/.local/share}"
bin="$HOME/.local/bin"
apps="$share/applications"
icons="$share/icons/hicolor"

refresh() {
	command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$apps" 2>/dev/null || true
	# (no icon cache in the user's folder: one would hide icons other programs add there later)
	touch "$icons" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
	rm -f "$bin/discipline" "$apps/discipline.desktop" \
		"$icons/32x32/apps/discipline.png" "$icons/128x128/apps/discipline.png" "$icons/256x256/apps/discipline.png"
	refresh
	echo "Discipline is removed. Your data is still in $share/matze64x.discipline."
	exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
start=$(awk '/^__PAYLOAD__$/ { print NR + 1; exit }' "$0")
tail -n +"$start" "$0" | tar -xzf - -C "$tmp"

mkdir -p "$bin" "$apps" "$icons/32x32/apps" "$icons/128x128/apps" "$icons/256x256/apps"
# (copied next to it and renamed: replacing a program that is running fails otherwise)
cp "$tmp/discipline" "$bin/.discipline.new"
chmod 755 "$bin/.discipline.new"
mv -f "$bin/.discipline.new" "$bin/discipline"
cp "$tmp/32x32.png" "$icons/32x32/apps/discipline.png"
cp "$tmp/128x128.png" "$icons/128x128/apps/discipline.png"
cp "$tmp/256x256.png" "$icons/256x256/apps/discipline.png"
cat >"$apps/discipline.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Discipline
Comment=Habit tracker
Exec="$bin/discipline"
Icon=discipline
StartupWMClass=discipline
Terminal=false
Categories=Utility;
EOF
refresh

echo "Discipline is installed: it's in your applications menu (or run $bin/discipline)."
if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4\.1'; then
	echo "Note: WebKitGTK 4.1 seems to be missing. Install it (Arch: webkit2gtk-4.1, Debian/Ubuntu: libwebkit2gtk-4.1-0)."
fi
exit 0
__PAYLOAD__
