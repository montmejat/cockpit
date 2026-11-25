#!/bin/sh
# Builds the desktop app and adds it to the app menu for this user (~/.local).
# The binary runs the cockpit sources from this checkout (or $COCKPIT_HOME), so keep the checkout where it is.
# desktop/release.sh runs this inside a release instead, so the binary runs that release.
set -e
cd "$(dirname "$0")"
(cd .. && npm "${NPM_INSTALL:-install}" --no-audit --no-fund && npm run build)   # the page the window shows
cargo build --release
mkdir -p ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/512x512/apps
install -m 755 "${CARGO_TARGET_DIR:-target}/release/cockpit" ~/.local/bin/cockpit
install -m 644 icons/icon.png ~/.local/share/icons/hicolor/512x512/apps/cockpit.png
# A patched WebKitGTK for 120Hz on NVIDIA (README), for the launcher only. Kept from the last install
# when not given, so reinstalling (or a release) doesn't drop it.
if [ -z "$COCKPIT_WEBKIT_LIB" ] && [ -f ~/.local/share/applications/cockpit.desktop ]; then
  COCKPIT_WEBKIT_LIB=$(sed -n 's/^Exec=env LD_LIBRARY_PATH=\([^ ]*\) .*/\1/p' ~/.local/share/applications/cockpit.desktop | head -1)
fi
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
SingleMainWindow=false
Actions=new-window;

# GNOME opens this for Ctrl+Enter in the app grid, Ctrl+click or middle-click on the dock icon
# while cockpit runs, and "New Window" on the icon's right-click menu: another window, asking which project.
[Desktop Action new-window]
Name=New Window
Exec=$EXEC --pick

DESKTOP
update-desktop-database ~/.local/share/applications 2>/dev/null || true
gtk-update-icon-cache -q ~/.local/share/icons/hicolor 2>/dev/null || true
echo "installed: ~/.local/bin/cockpit and the cockpit entry in the app menu"
