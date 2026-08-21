#!/bin/bash
#
# Double-click this file to start the Invoice & Food Cost app.
# A Terminal window opens and stays open while the app is running.
# Closing that window, or pressing Control-C in it, stops the app.

APP_DIR="/Users/catherinewang/Coding/invoice-cogs"
PORT=4000

# Homebrew installs node outside the PATH that Finder hands to scripts.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

clear 2>/dev/null || true
echo ""
echo "  ┌────────────────────────────────────────────┐"
echo "  │   Invoice & Food Cost                      │"
echo "  └────────────────────────────────────────────┘"
echo ""

pause_and_exit() {
  echo ""
  echo "  Press Return to close this window."
  read -r _
  exit "${1:-0}"
}

cd "$APP_DIR" 2>/dev/null || {
  echo "  Could not find the app folder:"
  echo "    $APP_DIR"
  echo ""
  echo "  If you moved or renamed it, tell Claude the new location."
  pause_and_exit 1
}

# Already running? Just open it rather than starting a second copy.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  The app is already running."
  echo ""
  echo "  Opening it in your browser..."
  open "http://localhost:$PORT"
  echo ""
  echo "  Address for coworkers:"
  echo "    http://$(scutil --get LocalHostName).local:$PORT"
  pause_and_exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed, and the app needs it to run."
  echo ""
  echo "  Download it from https://nodejs.org (choose the LTS version),"
  echo "  install it, then double-click this file again."
  pause_and_exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run — installing what the app needs. This takes a minute."
  echo ""
  npm install || {
    echo ""
    echo "  That did not finish. Check your internet connection and try again."
    pause_and_exit 1
  }
  echo ""
fi

echo "  Starting up..."
echo ""
echo "  On this Mac:    http://localhost:$PORT"
echo "  For coworkers:  http://$(scutil --get LocalHostName).local:$PORT"
echo ""
echo "  Your Mac will not fall asleep while this is running."
echo "  Leave the lid open and stay plugged in."
echo ""
echo "  ── To stop the app: close this window, or press Control-C ──"
echo ""

# Open the browser once the server has had a moment to come up.
( sleep 2; open "http://localhost:$PORT" ) &

npm start

echo ""
echo "  The app has stopped. Your coworkers can no longer reach it."
echo "  Double-click this file again to start it back up."
pause_and_exit 0
