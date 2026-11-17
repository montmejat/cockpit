#!/bin/sh
# Builds the desktop app and adds it to the app menu for this user (~/.local).
# The binary runs the cockpit sources from this checkout (or $COCKPIT_HOME), so keep the checkout where it is.
set -e
cd "$(dirname "$0")"
(cd .. && npm install --no-audit --no-fund && npm run build)   # the page the window shows
cargo build --release
mkdir -p ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/512x512/apps
install -m 755 target/release/cockpit ~/.local/bin/cockpit
install -m 644 icons/icon.png ~/.local/share/icons/hicolor/512x512/apps/cockpit.png
# A patched WebKitGTK for 120Hz on NVIDIA (README), for the launcher only.
EXEC="$HOME/.local/bin/cockpit"
[ -n "$COCKPIT_WEBKIT_LIB" ] && EXEC="env LD_LIBRARY_PATH=$COCKPIT_WEBKIT_LIB $EXEC"
cat > ~/.local/share/applications/cockpit.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=cockpit
Comment=See what the agents are building
Exec=$EXEC %f
Icon=cockpit
Terminal=false
Categories=Development;
StartupWMClass=io.github.montmejat.cockpit
Actions=pick;

[Desktop Action pick]
Name=Open project…
Exec=$EXEC --pick
DESKTOP
update-desktop-database ~/.local/share/applications 2>/dev/null || true
gtk-update-icon-cache -q ~/.local/share/icons/hicolor 2>/dev/null || true
echo "installed: ~/.local/bin/cockpit and the cockpit entry in the app menu"
