#!/bin/sh
set -eu

cd "$(dirname "$0")"

field() {
  sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" git-forge.json
}

version=$(field version)
expected=$(field sha256)
if [ -z "$version" ] || [ -z "$expected" ]; then
  echo "git-forge.json must contain \"version\" and \"sha256\"" >&2
  exit 1
fi
base=${GIT_FORGE_RELEASE_URL:-https://github.com/levino/git-forge/releases/download/v$version}
assets="git-forge-worker.mjs migrations.tar.gz"

verified() {
  [ -f "$1/SHA256SUMS" ] &&
    echo "$expected  $1/SHA256SUMS" | sha256sum -c --status - &&
    (cd "$1" && sha256sum -c --status --strict SHA256SUMS)
}

if verified dist && [ -d dist/migrations ]; then
  echo "git-forge $version: dist/ already matches git-forge.json"
  exit 0
fi

rm -rf dist.tmp
trap 'rm -rf dist.tmp' EXIT
mkdir dist.tmp

curl -fsSL --retry 3 -o dist.tmp/SHA256SUMS "$base/SHA256SUMS"
if ! echo "$expected  dist.tmp/SHA256SUMS" | sha256sum -c --status -; then
  echo "git-forge $version: SHA256SUMS does not match the sha256 in git-forge.json" >&2
  exit 1
fi
for asset in $assets; do
  curl -fsSL --retry 3 -o "dist.tmp/$asset" "$base/$asset"
done
if ! (cd dist.tmp && sha256sum -c --strict SHA256SUMS); then
  echo "git-forge $version: release assets do not match SHA256SUMS" >&2
  exit 1
fi
tar -xzf dist.tmp/migrations.tar.gz -C dist.tmp

rm -rf dist
mv dist.tmp dist
echo "git-forge $version: verified and unpacked into dist/"
