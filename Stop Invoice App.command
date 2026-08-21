#!/bin/bash
#
# Double-click this to stop the app, for when the Terminal window that
# started it has been lost or closed without stopping the server.

PORT=4000
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

clear 2>/dev/null || true
echo ""
echo "  Stopping Invoice & Food Cost..."
echo ""

if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  It was not running. Nothing to stop."
else
  pkill -f "caffeinate -is node server.js" 2>/dev/null
  pkill -f "node server.js" 2>/dev/null
  sleep 1
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  Something is still holding port $PORT. Restarting your Mac will clear it."
  else
    echo "  Stopped. Your Mac can sleep again, and coworkers can no longer reach the app."
  fi
fi

echo ""
echo "  Press Return to close this window."
read -r _
