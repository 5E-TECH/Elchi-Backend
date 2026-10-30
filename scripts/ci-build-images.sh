#!/usr/bin/env bash
#
# ZfI9nERJ: build the service images on the GitHub runner instead of the server
# and push them to GHCR. Called by deploy.yml, only with CI_IMAGES_ENABLED.
#
#   ghcr.io/<owner>/<repo>/<service>:<IMAGE_TAG>   apps/<service>/Dockerfile
#   ghcr.io/<owner>/<repo>/ops:<IMAGE_TAG>         Dockerfile.ops
#
# An image that already exists is left alone: `test` built this commit, so
# production gets the very image the test server ran. Layers are shared in the
# local builder (same `npm ci`), so the whole run takes minutes, not an hour.
#
# Env: GHCR_TOKEN (job token, packages: write), IMAGE_TAG (commit sha),
#      GITHUB_ACTOR, GITHUB_REPOSITORY (set by Actions).
set -euo pipefail

: "${GHCR_TOKEN:?}" "${IMAGE_TAG:?}" "${GITHUB_ACTOR:?}" "${GITHUB_REPOSITORY:?}"
REPO="ghcr.io/$(printf '%s' "$GITHUB_REPOSITORY" | tr 'A-Z' 'a-z')"

printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin > /dev/null

build() { # <image name> <dockerfile>
  local img="$REPO/$1:$IMAGE_TAG"
  if docker manifest inspect "$img" > /dev/null 2>&1; then
    echo "$img already in the registry — reused"
    return 0
  fi
  docker build -f "$2" -t "$img" \
    --label "org.opencontainers.image.source=https://github.com/$GITHUB_REPOSITORY" .
  docker push "$img"
}

for dockerfile in apps/*/Dockerfile; do
  service="${dockerfile#apps/}"
  build "${service%/Dockerfile}" "$dockerfile"
done
build ops Dockerfile.ops
