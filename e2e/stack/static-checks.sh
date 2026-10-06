#!/usr/bin/env bash
# Checks what the browser tests can't see directly: the web image's headers,
# routing and content types, as served through the gateway.
set -euo pipefail

BASE="${1:-http://localhost:8080}"
pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; exit 1; }

headers() { curl -fsS -D - -o /dev/null "$BASE$1"; }
header() { headers "$1" | tr -d '\r' | grep -i "^$2:" | head -1 | cut -d' ' -f2-; }
status() { curl -s -o /dev/null -w '%{http_code}' "$BASE$1"; }

csp="$(header / content-security-policy)"
[ "$csp" = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:" ] ||
  fail "content security policy on /: $csp"
[ "$(header / x-frame-options)" = DENY ] || fail "frame options on /"
[ "$(header / x-content-type-options)" = nosniff ] || fail "nosniff on /"
[ "$(header / referrer-policy)" = no-referrer ] || fail "referrer policy on /"
[ "$(header / permissions-policy)" = "camera=(self), microphone=(), geolocation=()" ] || fail "permissions policy on /"
[ "$(header / cache-control)" = no-cache ] || fail "the index must be revalidated"
pass "security headers and revalidation on the index"

for path in /s /how /share /c /no-such-page; do
  [ "$(status "$path")" = 200 ] || fail "$path should serve the app"
  curl -fsS "$BASE$path" | grep -q '<div id="root">' || fail "$path should be the app's index"
done
pass "app routes fall back to the index, without redirects"

[ "$(header /manifest.webmanifest content-type)" = application/manifest+json ] || fail "manifest content type"
[ "$(header /manifest.webmanifest content-security-policy)" = "$csp" ] || fail "headers on the manifest"
pass "the manifest is served as a manifest"

asset="$(curl -fsS "$BASE/" | grep -o '/assets/index-[^"]*\.js' | head -1)"
[ -n "$asset" ] || fail "no script asset in the index"
[ "$(header "$asset" cache-control)" = "public, max-age=31536000, immutable" ] || fail "assets must be cached for good"
[ "$(header "$asset" content-security-policy)" = "$csp" ] || fail "headers on assets"
[ "$(status /assets/no-such-file.js)" = 404 ] || fail "a missing asset must be a 404, not the index"
pass "hashed assets are cached for good, missing ones are 404s"

[ "$(header /sw.js cache-control)" = no-cache ] || fail "the service worker must be revalidated"
pass "the service worker is revalidated"

curl -fsS "$BASE/api/v1/version" | grep -q '"version"' || fail "the API answers through the gateway"
pass "the gateway routes /api/ to the server"

echo "all static checks passed against $BASE"
