#!/bin/sh
set -e
: "${BUNNY_API_KEY:?}" "${BUNNY_SCRIPT_ID:?}"
here=$(cd "$(dirname "$0")" && pwd)
api=https://api.bunny.net/compute/script/$BUNNY_SCRIPT_ID
node -e 'process.stdout.write(JSON.stringify({ Code: require("fs").readFileSync(process.argv[1], "utf8") }))' "$here/dist/edge.js" |
  curl -sf -X POST -H "AccessKey: $BUNNY_API_KEY" -H 'content-type: application/json' --data-binary @- "$api/code"
curl -sf -X POST -H "AccessKey: $BUNNY_API_KEY" -H 'content-type: application/json' -d '{}' "$api/publish"
