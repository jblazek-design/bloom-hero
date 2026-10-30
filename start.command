#!/bin/bash
# Double-click to run the site locally (camera needs http://localhost, not file://)
cd "$(dirname "$0")"
PORT=5173
( sleep 1; open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" ) &
echo "Bloom running at http://localhost:$PORT  (Ctrl+C to stop)"
python3 -m http.server $PORT
