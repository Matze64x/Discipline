#!/bin/sh
# Runs the end-to-end tests (Firefox, and WebKit as on the iPhone) in Microsoft's Playwright image,
# the same way here and in CI, so both render alike (same browsers, same fonts). Playwright's
# WebKit build also needs Ubuntu's libraries (ICU 74, …), which e.g. Arch doesn't have.
# The image matches the installed Playwright version. Extra arguments go to `playwright test`
# (e.g. --project=iphone, a spec name, -g "<test>").
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('@playwright/test/package.json').version")
# the app's version (vite.config.ts) is read here: the image may not be able to run git on the
# checkout, and every build would then be "unknown" (updates never seen)
app_version=$(git log -1 --format="%cd %h" --date=format:%Y-%m-%d)
exec docker run --rm --init --ipc=host \
	--user "$(id -u):$(id -g)" --env HOME=/tmp --env CI --env DISCIPLINE_IN_CONTAINER=1 --env DISCIPLINE_VERSION="$app_version" \
	--volume "$PWD:/work" --workdir /work \
	"mcr.microsoft.com/playwright:v$version-noble" \
	npx playwright test "$@"
