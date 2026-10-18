#!/bin/sh
set -eu
if [ $# -ne 1 ]; then
  echo "usage: sh claim-admin.sh <verified email or OIDC subject>" >&2
  exit 2
fi
identity=$(printf '%s' "$1" | sed "s/'/''/g")
npx --yes wrangler@4 d1 execute DB --remote --command "INSERT INTO instance_admin_claims (identity, created_at) VALUES ('$identity', $(date +%s)000) ON CONFLICT (identity) DO NOTHING"
echo "Claim stored. Sign in with OIDC as $1 once; the claim turns that account into an instance admin and is removed."
