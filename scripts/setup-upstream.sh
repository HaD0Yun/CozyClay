#!/bin/sh
set -eu

UPSTREAM_URL="https://github.com/earendil-works/pi.git"

root=$(git rev-parse --show-toplevel)
cd "$root"

if git remote get-url upstream >/dev/null 2>&1; then
	git remote set-url upstream "$UPSTREAM_URL"
else
	git remote add upstream "$UPSTREAM_URL"
fi

git remote set-url --push upstream DISABLED
git fetch upstream main

test "$(git remote get-url upstream)" = "$UPSTREAM_URL"
test "$(git remote get-url --push upstream)" = "DISABLED"

printf '%s\n' "upstream fetch: $UPSTREAM_URL"
printf '%s\n' "upstream push: DISABLED"
printf '%s\n' "upstream/main: $(git rev-parse upstream/main)"
