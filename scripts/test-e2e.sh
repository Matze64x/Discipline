#!/bin/sh
# Runs the end-to-end tests (Firefox, and WebKit as on the iPhone) in Microsoft's Playwright image,
# the same way here and in CI, so both render alike (same browsers, same fonts). Playwright's
# WebKit build also needs Ubuntu's libraries (ICU 74, …), which e.g. Arch doesn't have.
# The image matches the installed Playwright version. Extra arguments go to `playwright test`
# (e.g. --project=iphone, a spec name, -g "<test>").
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('@playwright/test/package.json').version")
exec docker run --rm --init --ipc=host \
	--user "$(id -u):$(id -g)" --env HOME=/tmp --env CI --env DISCIPLINE_IN_CONTAINER=1 \
	--volume "$PWD:/work" --workdir /work \
	"mcr.microsoft.com/playwright:v$version-noble" \
	npx playwright test "$@"
