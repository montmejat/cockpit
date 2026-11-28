#!/bin/sh
# A second cockpit in the app menu, "cockpit dev", that runs this checkout as it is, beside the
# installed release: what you (or an agent) edit here is what it runs, nothing pushed. Its top bar
# says "dev". The page's changes show after `npm run build` (it offers "reload page"); the server's
# after a restart (it offers "restart cockpit").
#   desktop/dev.sh           build the page, add "cockpit dev" to the app menu (once), and open it
#   desktop/dev.sh --menu    only add the menu entry
# It runs the installed binary (~/.local/bin/cockpit, from desktop/release.sh or desktop/install.sh)
# with COCKPIT_HOME set to this checkout, so the release itself is left alone.
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
BIN="$HOME/.local/bin/cockpit"
[ -x "$BIN" ] || { echo "no $BIN yet: install cockpit first (desktop/release.sh)"; exit 1; }

# The launcher, with the same patched WebKitGTK as the release's if it has one (README).
LIB=$(sed -n 's/^Exec=env LD_LIBRARY_PATH=\([^ ]*\) .*/\1/p' ~/.local/share/applications/cockpit.desktop 2>/dev/null | head -1)
EXEC="env COCKPIT_HOME=$REPO${LIB:+ LD_LIBRARY_PATH=$LIB} $BIN"
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/cockpit-dev.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=cockpit dev
Comment=cockpit from its checkout ($REPO), beside the installed release
Exec=$EXEC %f
Icon=cockpit
Terminal=false
Categories=Development;
SingleMainWindow=false
Actions=new-window;

[Desktop Action new-window]
Name=New Window
Exec=$EXEC --pick
DESKTOP
update-desktop-database ~/.local/share/applications 2>/dev/null || true
echo "added: cockpit dev in the app menu (runs $REPO)"
[ "$1" = "--menu" ] && exit 0

(cd "$REPO" && npm run -s build >/dev/null)
echo "page built; opening cockpit dev"
# shellcheck disable=SC2086
setsid $EXEC >/dev/null 2>&1 &
