#!/bin/sh
# Installed releases of cockpit. CI tags master (vYYYY.MM.DD.N) when its checks pass; a release is
# such a tag unpacked and built on its own, so what you edit in the checkout isn't what you run.
#   desktop/release.sh            fetch, install the newest tag and switch to it
#   desktop/release.sh <tag>      install that tag and switch to it (going back to an older one)
#   desktop/release.sh list       the tags: * the one in use, + installed
# Each lives in ~/.local/share/cockpit/releases/<tag> (with a VERSION file: src/version.ts), built
# with its own desktop/install.sh, which points the app menu and ~/.local/bin/cockpit at it. The
# newest 5 are kept. desktop/install.sh run from the checkout goes back to running the checkout.
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
DIR=${COCKPIT_RELEASES:-${XDG_DATA_HOME:-$HOME/.local/share}/cockpit/releases}
# One cargo target for every release, so a release where desktop/ didn't change builds in seconds.
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/cockpit/desktop-target}
tags() { git -C "$REPO" tag --list 'v*' --sort=-v:refname; }
current() { basename "$(readlink "$DIR/current" 2>/dev/null)" 2>/dev/null || true; }

case "$1" in
  list)
    cur=$(current)
    for t in $(tags); do
      m=" "; [ -f "$DIR/$t/.built" ] && m="+"; [ "$t" = "$cur" ] && m="*"
      echo "$m $t"
    done
    exit 0 ;;
  -*) sed -n '2,9s/^# \{0,1\}//p' "$0"; exit 0 ;;
  "") git -C "$REPO" fetch --tags --quiet origin; tag=$(tags | head -1)
      [ -n "$tag" ] || { echo "no release tags yet (CI makes one when master passes its checks)"; exit 1; } ;;
  *)  tag=$1
      git -C "$REPO" rev-parse -q --verify "refs/tags/$tag" >/dev/null || git -C "$REPO" fetch --tags --quiet origin ;;
esac
git -C "$REPO" rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null || { echo "no tag $tag"; exit 1; }

dest=$DIR/$tag
if [ "$tag" = "$(current)" ] && [ -f "$dest/.built" ]; then echo "already on $tag"; exit 0; fi
if [ ! -f "$dest/.built" ]; then
  # Built where it will run: the binary keeps the path of the sources it was built with.
  echo "building $tag in $dest"
  rm -rf "$dest"; mkdir -p "$dest"
  git -C "$REPO" archive "$tag" | tar -x -C "$dest"
  echo "$tag" > "$dest/VERSION"
  NPM_INSTALL=ci sh "$dest/desktop/install.sh"
  touch "$dest/.built"
else
  sh "$dest/desktop/install.sh" >/dev/null   # its binary and app menu entry again
fi
# Where it came from: the release looks there for newer tags and installs them (src/update.ts).
echo "$REPO" > "$dest/CHECKOUT"
ln -sfn "$tag" "$DIR/current"

# The newest 5 stay (and the one in use, if older); a window still open on a removed one keeps
# running from memory until it's closed, but can't start new project servers.
cur=$(current)
ls -1 "$DIR" | grep '^v' | sort -rV | tail -n +6 | while read -r old; do
  [ "$old" = "$cur" ] || rm -rf "${DIR:?}/$old"
done
echo "cockpit $tag installed: close and reopen cockpit's windows to run it"
