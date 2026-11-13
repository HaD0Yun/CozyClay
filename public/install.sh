#!/bin/bash
# CozyClay for macOS, without installing Node.js yourself:
#   curl -fsSL https://cozyclay.org/install.sh | bash
# It puts a portable Node.js and a launcher in ~/Library/Application Support/CozyClay (no admin password), creates
# ~/Applications/CozyClay.app to double-click from then on, and starts CozyClay. Nothing else on the Mac is changed.
# Remove it with: rm -rf ~/Applications/CozyClay.app ~/Library/Application\ Support/CozyClay
set -euo pipefail

NODE_VERSION="v26.13.1"
ROOT="${COZYCLAY_HOME:-$HOME/Library/Application Support/CozyClay}"
APP="${COZYCLAY_APP:-$HOME/Applications/CozyClay.app}"

[ "$(uname -s)" = "Darwin" ] || { echo "This installer is for macOS. On other systems: npx cozyclay"; exit 1; }
case "$(uname -m)" in
	arm64) ARCH="arm64" ;;
	x86_64) ARCH="x64" ;;
	*) echo "Unsupported Mac: $(uname -m)"; exit 1 ;;
esac

NAME="node-$NODE_VERSION-darwin-$ARCH"
mkdir -p "$ROOT"
if [ ! -x "$ROOT/node/bin/node" ] || [ "$("$ROOT/node/bin/node" --version 2>/dev/null)" != "$NODE_VERSION" ]; then
	echo "Downloading what CozyClay needs (about 50 MB)..."
	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	curl -fL --progress-bar "https://nodejs.org/dist/$NODE_VERSION/$NAME.tar.gz" -o "$TMP/$NAME.tar.gz"
	WANT="$(curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | awk -v f="$NAME.tar.gz" '$2 == f { print $1 }')"
	HAVE="$(shasum -a 256 "$TMP/$NAME.tar.gz" | awk '{ print $1 }')"
	[ -n "$WANT" ] && [ "$WANT" = "$HAVE" ] || { echo "The download did not match its checksum. Nothing was installed."; exit 1; }
	tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP"
	rm -rf "$ROOT/node"
	mv "$TMP/$NAME" "$ROOT/node"
fi

cat > "$ROOT/CozyClay.command" << 'LAUNCH'
#!/bin/bash
# Starts the newest CozyClay with the Node.js next to this file. Extra arguments go to cozyclay.
cd "$(dirname "$0")"
export PATH="$PWD/node/bin:$PATH"
printf '\n  Starting CozyClay. The Studio opens in your browser.\n  Keep this window open while you work. Close it to stop CozyClay.\n  The first start downloads CozyClay and can take a few minutes.\n\n'
npx --yes cozyclay@latest --via installer "$@" || { printf '\n  CozyClay stopped with an error. Check your internet connection and start it again.\n'; read -r -p "  Press Return to close. "; }
LAUNCH
chmod +x "$ROOT/CozyClay.command"

# The app is made here, on this Mac, so macOS opens it with a double-click.
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/MacOS/CozyClay" << APPRUN
#!/bin/bash
exec /usr/bin/open -a Terminal "$ROOT/CozyClay.command"
APPRUN
chmod +x "$APP/Contents/MacOS/CozyClay"
cat > "$APP/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>CFBundleName</key><string>CozyClay</string>
	<key>CFBundleIdentifier</key><string>org.cozyclay.launcher</string>
	<key>CFBundleExecutable</key><string>CozyClay</string>
	<key>CFBundleIconFile</key><string>CozyClay</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>
PLIST
# The icon is a nicety: without it the app still works.
ICON="$(mktemp -d)"
if curl -fsSL "https://cozyclay.org/icons/icon-512.png" -o "$ICON/icon.png" 2>/dev/null; then
	sips -s format icns "$ICON/icon.png" --out "$APP/Contents/Resources/CozyClay.icns" > /dev/null 2>&1 || true
fi
rm -rf "$ICON"
touch "$APP"

echo
echo "CozyClay is installed. Next time, open CozyClay from your Applications folder (in your home folder) or Spotlight."
[ -n "${COZYCLAY_NO_LAUNCH:-}" ] || exec "$ROOT/CozyClay.command"
