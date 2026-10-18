#!/bin/sh
set -eu

cli=$(cd "$(dirname "$0")" && pwd)
out=${1:-$cli/dist}
mkdir -p "$out"
out=$(cd "$out" && pwd)

for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64; do
  suffix=""
  [ "$target" = windows-x64 ] && suffix=".exe"
  (cd "$cli" && bun build --compile --minify --target="bun-$target" src/main.ts --outfile "$out/git-forge-$target$suffix" >/dev/null)
done
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) "$out/git-forge-linux-x64" --version >/dev/null ;;
esac
(cd "$out" && sha256sum git-forge-* >CLI-SHA256SUMS)
