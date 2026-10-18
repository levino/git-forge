#!/bin/sh
set -eu

cd "$(dirname "$0")"

wrangler=${WRANGLER:-npx --yes wrangler@4}

sh build.sh
if $wrangler d1 info DB >/dev/null 2>&1; then
  $wrangler d1 migrations apply DB --remote
  $wrangler deploy
else
  echo "D1 database for binding DB does not exist yet: the first deploy provisions it, then the migrations run"
  $wrangler deploy
  $wrangler d1 migrations apply DB --remote
fi
