#!/usr/bin/env bash
# Runs the whole of Secretli with this web app: builds this repository's
# image and starts the stack from secretli/e2e with it, on
# http://localhost:8080. The e2e repository is expected next to this one
# (../e2e or ../secretli-e2e), or wherever E2E_DIR points.
#
#   e2e/stack.sh up     build this image, start everything, wait
#   e2e/stack.sh down   stop everything and drop the data
#   e2e/stack.sh logs   print every service's logs
#
# WEB_VERSION sets the commit the footer shows (default dev); SERVER_IMAGE
# picks another server than the latest published one.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
e2e="${E2E_DIR:-}"
if [ -z "$e2e" ]; then
  for candidate in "$here/../e2e" "$here/../secretli-e2e"; do
    if [ -x "$candidate/stack/stack.sh" ]; then
      e2e="$candidate"
      break
    fi
  done
fi
if [ -z "$e2e" ] || [ ! -x "$e2e/stack/stack.sh" ]; then
  echo "no checkout of secretli/e2e found: clone it next to this repository or set E2E_DIR" >&2
  exit 2
fi

if [ "${1:-}" = up ]; then
  docker build --build-arg VERSION="${WEB_VERSION:-dev}" -t secretli-web:local "$here"
fi
WEB_IMAGE=secretli-web:local exec "$e2e/stack/stack.sh" "$@"
