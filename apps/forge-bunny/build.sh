#!/bin/sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
version=${GIT_FORGE_VERSION:-$(cat "$here/../../release/VERSION")}
cd "$here/../forge-worker"
GIT_FORGE_VERSION=$version node_modules/.bin/astro build --config ../forge-bunny/astro.config.ts
cd "$here"
node_modules/.bin/esbuild src/main.ts --bundle --format=esm --platform=neutral --target=es2023 --main-fields=module,main --conditions=import,default \
  --external:'node:*' --alias:cloudflare:workers=./src/astro-adapter-runtime.ts --alias:git-forge:astro-entry=./dist/astro/server/entry.mjs \
  --define:GIT_FORGE_VERSION="\"$version\"" --minify --log-level=warning --outfile=dist/edge.js
ls -la dist/edge.js
