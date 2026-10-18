#!/bin/sh
set -eu

app=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$app/../.." && pwd)
out=${1:-$app/dist}
mkdir -p "$out"
out=$(cd "$out" && pwd)
version=$(tr -d '[:space:]' <"$root/release/VERSION")

for target in linux-x64 linux-arm64; do
  (cd "$app" && bun build --compile --minify --target="bun-$target" --define "GIT_FORGE_VERSION=\"$version\"" src/main.ts --outfile "$out/git-forge-node-$target" >/dev/null)
done
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) "$out/git-forge-node-linux-x64" version ;;
  Linux-aarch64) "$out/git-forge-node-linux-arm64" version ;;
esac
(cd "$out" && sha256sum git-forge-node-* >NODE-SHA256SUMS)
