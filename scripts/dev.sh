#!/bin/bash
# Run the server from source (edit server/static/* and just refresh the page).
# Uses a separate data folder so development never touches your real SlideMate data.
cd "$(dirname "$0")/../server"
export SLIDEMATE_DATA="${SLIDEMATE_DATA:-$HOME/Library/Application Support/SlideMate-dev}"
export SLIDEMATE_PORT="${SLIDEMATE_PORT:-8768}"
echo "Open http://127.0.0.1:$SLIDEMATE_PORT"
exec python3 server.py
