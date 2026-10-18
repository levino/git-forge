#!/bin/sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/release/dist}
migration_dirs="packages/accounts/migrations"

mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

(cd "$root/apps/forge-worker" && NODE_ENV=production ASTRO_TELEMETRY_DISABLED=1 WRANGLER_SEND_METRICS=false ./node_modules/.bin/astro build >"$work/astro.log" 2>&1) || {
  cat "$work/astro.log" >&2
  exit 1
}
(cd "$root/apps/forge-worker" && WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy dist/server/entry.mjs --config wrangler.jsonc --dry-run --containers-rollout=none --outdir "$work/bundle" >"$work/wrangler.log" 2>&1) || {
  cat "$work/wrangler.log" >&2
  exit 1
}
cp "$work/bundle/entry.js" "$out/git-forge-worker.mjs"

mkdir "$work/migrations"
for dir in $migration_dirs; do
  cp "$root/$dir"/*.sql "$work/migrations/"
done
tar -C "$work" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - migrations | gzip -n -9 >"$out/migrations.tar.gz"

(cd "$out" && sha256sum git-forge-worker.mjs migrations.tar.gz >SHA256SUMS)
sha256sum "$out/SHA256SUMS" | cut -d' ' -f1
