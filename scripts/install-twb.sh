#!/usr/bin/env bash
# Install this fork into Paperclip's plugin node_modules as a sibling plugin
# named `paperclip-plugin-telegram-twb`, leaving the upstream `paperclip-plugin-telegram`
# intact so both versions can coexist in the installed plugin list.
#
# Usage:
#   ./scripts/install-twb.sh [PAPERCLIP_PLUGINS_DIR]
#
# Default PAPERCLIP_PLUGINS_DIR: ~/.paperclip/plugins
#
# After running, the board must:
#   1) Disable the stock `paperclip-plugin-telegram` instance in the Paperclip
#      UI (both cannot long-poll the same bot token).
#   2) Configure the new `paperclip-plugin-telegram-twb` instance with the
#      Telegram token ref and the new filter / inbox fields.
#   3) Restart Paperclip (or the plugin worker) for the new manifest to load.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGINS_DIR="${1:-$HOME/.paperclip/plugins}"
NEW_NAME="paperclip-plugin-telegram-twb"
TARGET="$PLUGINS_DIR/node_modules/$NEW_NAME"

if [ ! -d "$HERE/dist" ]; then
  echo "dist/ is missing. Run 'npm run build' first." >&2
  exit 1
fi

echo "Installing $NEW_NAME into $TARGET"
mkdir -p "$TARGET"
# Copy essentials
rm -rf "$TARGET/dist"
cp -R "$HERE/dist" "$TARGET/dist"
cp "$HERE/package.json" "$TARGET/package.json"
[ -f "$HERE/README.md" ] && cp "$HERE/README.md" "$TARGET/README.md" || true
[ -f "$HERE/LICENSE" ] && cp "$HERE/LICENSE" "$TARGET/LICENSE" || true

# Rewrite package.json name so Paperclip sees a distinct package
node -e "
const fs=require('fs');
const p='$TARGET/package.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.name='$NEW_NAME';
j.version=(j.version||'0.0.0')+'-twb';
j.description='(twb-digital fork) '+(j.description||'');
fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');
console.log('package.json → name='+j.name+' version='+j.version);
"

# Rewrite PLUGIN_ID in the built constants.js so Paperclip registers it under the new id
node -e "
const fs=require('fs');
const p='$TARGET/dist/constants.js';
let s=fs.readFileSync(p,'utf8');
const before=s;
s=s.replace(/export const PLUGIN_ID\s*=\s*\"paperclip-plugin-telegram\";/, 'export const PLUGIN_ID = \"$NEW_NAME\";');
if (s===before) { console.error('ERROR: could not rewrite PLUGIN_ID'); process.exit(1); }
fs.writeFileSync(p,s);
console.log('constants.js → PLUGIN_ID=$NEW_NAME');
"

# Register in the installed plugins package.json if not already present
PLUGINS_MANIFEST="$PLUGINS_DIR/package.json"
if [ -f "$PLUGINS_MANIFEST" ]; then
  node -e "
  const fs=require('fs');
  const p='$PLUGINS_MANIFEST';
  const j=JSON.parse(fs.readFileSync(p,'utf8'));
  j.dependencies=j.dependencies||{};
  if (!j.dependencies['$NEW_NAME']) {
    j.dependencies['$NEW_NAME']='file:./node_modules/$NEW_NAME';
    fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');
    console.log('plugins/package.json → added $NEW_NAME');
  } else {
    console.log('plugins/package.json → $NEW_NAME already present');
  }
  "
else
  echo "Warning: $PLUGINS_MANIFEST not found; add '$NEW_NAME' manually." >&2
fi

echo
echo "Done. Next:"
echo "  1. Disable the stock paperclip-plugin-telegram instance in Paperclip UI"
echo "     (both cannot long-poll the same bot token)."
echo "  2. Configure the new $NEW_NAME instance (token ref + new flags)."
echo "  3. Restart Paperclip / the plugin worker."
