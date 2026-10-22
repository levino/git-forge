# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
ARG BUN_VERSION=1.4.2
ARG PNPM_VERSION=12.5.1
ARG TARGETARCH
WORKDIR /src
RUN npm install -g "bun@${BUN_VERSION}" "pnpm@${PNPM_VERSION}"
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter forge-node...
RUN case "$TARGETARCH" in amd64) target=linux-x64 ;; arm64) target=linux-arm64 ;; *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; esac \
 && version=$(tr -d '[:space:]' < release/VERSION) \
 && cd apps/forge-node \
 && bun build --compile --minify --target="bun-$target" --define "GIT_FORGE_VERSION=\"$version\"" src/main.ts --outfile /out/git-forge-node \
 && mkdir /out/data

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /out/git-forge-node /usr/local/bin/git-forge-node
COPY --from=build --chown=65532:65532 /out/data /data
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/git-forge-node"]
CMD ["serve"]
