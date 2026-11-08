#!/bin/sh
# Builds the desktop app and adds it to the app menu for this user (~/.local).
# The binary runs the cockpit sources from this checkout (or $COCKPIT_HOME), so keep the checkout where it is.
set -e
cd "$(dirname "$0")"
cargo build --release
mkdir -p ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/512x512/apps
install -m 755 target/release/cockpit ~/.local/bin/cockpit
install -m 644 icons/icon.png ~/.local/share/icons/hicolor/512x512/apps/cockpit.png
cat > ~/.local/share/applications/cockpit.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=cockpit
Comment=See what the agents are building
Exec=$HOME/.local/bin/cockpit %f
Icon=cockpit
Terminal=false
Categories=Development;
StartupWMClass=cockpit
Actions=pick;

[Desktop Action pick]
Name=Open project…
Exec=$HOME/.local/bin/cockpit --pick
DESKTOP
update-desktop-database ~/.local/share/applications 2>/dev/null || true
gtk-update-icon-cache -q ~/.local/share/icons/hicolor 2>/dev/null || true
echo "installed: ~/.local/bin/cockpit and the cockpit entry in the app menu"
