#!/bin/sh
set -eu
config="${ACTIONS_RUNNER_JITCONFIG:?ACTIONS_RUNNER_JITCONFIG must hold the encoded JIT config}"
unset ACTIONS_RUNNER_JITCONFIG
exec /home/runner/run.sh --jitconfig "$config"
