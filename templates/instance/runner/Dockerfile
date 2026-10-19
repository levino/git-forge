ARG RUNNER_VERSION=2.338.0
FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}

ARG NODE_VERSION=22.22.0

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1

USER runner
WORKDIR /home/runner
COPY --chown=runner:docker hook.js /home/runner/hook.js
ENV ACTIONS_RUNNER_CONTAINER_HOOKS=/home/runner/hook.js
