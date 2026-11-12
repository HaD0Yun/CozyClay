#!/bin/bash
# Starts the newest CozyClay with the Node.js inside the app (Apple silicon or Intel). Extra arguments go to cozyclay.
cd "$(dirname "$0")"
case "$(uname -m)" in arm64) NODE="$PWD/node-arm64" ;; *) NODE="$PWD/node-x64" ;; esac
export PATH="$NODE/bin:$PATH"
printf '\n  Starting CozyClay. The Studio opens in your browser.\n  Keep this window open while you work. Close it to stop CozyClay.\n  The first start downloads CozyClay and can take a few minutes.\n\n'
cd "$HOME"
npx --yes cozyclay@latest --via installer "$@" || { printf '\n  CozyClay stopped with an error. Check your internet connection and start it again.\n'; read -r -p "  Press Return to close. "; }
