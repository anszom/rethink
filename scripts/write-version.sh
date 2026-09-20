#!/bin/sh
# Bakes the git revision into the build by replacing the transpiled util/version.js, which otherwise
# asks git at runtime.
#
# A Docker build has no .git to ask (it is in .dockerignore), so the revision can be handed in
# through the GIT_REVISION environment variable instead, which takes precedence.
#
# Plain sh rather than bash: the Alpine build stage in the Dockerfile has no bash.

cd "$(dirname "$0")/.." || exit 1

revision=${GIT_REVISION:-$(git describe --always --dirty --tags 2>/dev/null)}
revision=${revision:-unknown}

# CI passes a full commit hash; shorten it to match what git describe prints
if printf '%s' "$revision" | grep -Eqx '[0-9a-f]{40}'; then
    revision=$(printf '%s' "$revision" | cut -c1-7)
fi

# a tag name may contain a quote or a backslash
escaped=$(printf '%s' "$revision" | sed "s/[\\\\']/\\\\&/g")

printf "export const revision = '%s'\n" "$escaped" > dist/util/version.js
echo "[write-version] $revision"
