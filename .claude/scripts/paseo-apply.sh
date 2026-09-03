#!/usr/bin/env bash
# Install the freshly built Paseo release once no agent is running.
#
# This exists because the installer stops the daemon, and the session that normally
# runs ./scripts/local-stack.sh --apply is itself an agent inside that daemon. Run it
# detached so it survives its own parent being torn down.
#
#   nohup .claude/scripts/paseo-apply.sh > .dev/paseo-apply.log 2>&1 &
#
# It waits for an all-idle readback, installs, then stamps the runtime fingerprint the
# local-stack check compares against.

set -euo pipefail

PRODUCT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASEO_BIN="${PASEO_BIN:-$HOME/.local/bin/paseo}"
WAIT_SECONDS="${PASEO_APPLY_WAIT_SECONDS:-1800}"

version="$(node -e "console.log(require('$PRODUCT_ROOT/package.json').version)")"
arch="$(node -e 'console.log(process.arch)')"
bundle="$PRODUCT_ROOT/artifacts/paseo-web-cli-$version-macos-$arch"

say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

[ -x "$bundle/install.sh" ] || { say "no installer at $bundle/install.sh"; exit 1; }

busy_count() {
  PASEO_HOST= "$PASEO_BIN" ls --global --json 2>/dev/null |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      let a=[];try{a=JSON.parse(s);a=Array.isArray(a)?a:(a.agents??[])}catch{}
      console.log(a.filter(x=>['running','starting','initializing'].includes(String(x.status??''))).length)})" ||
    echo unknown
}

say "waiting for an idle daemon (up to ${WAIT_SECONDS}s)"
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  busy="$(busy_count)"
  if [ "$busy" = "0" ]; then
    say "all agents idle — installing $version"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    say "still $busy agent(s) running after ${WAIT_SECONDS}s — not installing"
    exit 1
  fi
  sleep 10
done

"$bundle/install.sh"

# Stamp the runtime scope so ./scripts/local-stack.sh reports fresh instead of stale.
# The hash function lives in local-stack.sh; borrow it rather than keeping a second copy
# that could drift from the one the check compares against.
eval "$(sed -n '/^runtime_fingerprint() {/,/^}/p' "$PRODUCT_ROOT/scripts/local-stack.sh")"
release_dir="$( cd "$(dirname "$(readlink "$PASEO_BIN" || echo "$PASEO_BIN")")/.." && pwd )"
runtime_fingerprint "$PRODUCT_ROOT" > "$release_dir/.local-stack-runtime-fp"

say "installed; verify with ./scripts/local-stack.sh"
