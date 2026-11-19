#!/usr/bin/env bash
# Builds MiniMessenger and installs it into /Applications.
set -euo pipefail

cd "$(dirname "$0")/.."

npm run dist

app="$(ls -d dist/mac*/MiniMessenger.app | head -n 1)"
dest="/Applications/MiniMessenger.app"

if pgrep -xq MiniMessenger; then
  echo "Quitting running MiniMessenger..."
  osascript -e 'quit app "MiniMessenger"' || true
  sleep 2
fi

rm -rf "$dest"
cp -R "$app" "$dest"

# Locally built apps are not quarantined, but clear the flag anyway so
# Gatekeeper never blocks the unsigned (ad-hoc signed) bundle.
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

codesign --verify --deep "$dest"

# macOS caches app icons (Launch Services, Notification Center). Re-register
# the bundle so a new icon shows up in notifications and the Dock.
touch "$dest"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dest" || true
killall usernoted NotificationCenter 2>/dev/null || true

echo "Installed $dest"
