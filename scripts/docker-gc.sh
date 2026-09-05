#!/usr/bin/env bash
#
# Reclaim the disk a deploy leaves behind (Audit devops).
#
# Every deploy rebuilds and retags the 14 service images, and the superseded
# ones stay on disk because a running container still references them by id.
# The build that produced them leaves its cache behind too. Nothing capped
# either, so over five months the box reached 156G/81% full — 87.65GB of build
# cache and 640 images — while the data the project actually owns (the
# postgres/rabbitmq/minio volumes) was 138MB of that.
#
# `docker image prune -a` does NOT cover this. The daemon uses the containerd
# image store, where prune only drops dangling images, not the superseded
# service tags. So this matches image ids against what the containers actually
# reference and removes the rest — which can never touch an image in use.
#
# Usage:
#   scripts/docker-gc.sh                 # ad-hoc
#   CACHE_KEEP=72h scripts/docker-gc.sh  # keep less build cache
#
# Runs automatically at the end of a successful deploy (.github/workflows/
# deploy.yml). A weekly cron on the server is the backstop for the weeks
# nothing ships:
#   15 4 * * 0  root  /usr/local/bin/elchi-docker-gc > /var/log/elchi-docker-gc.log 2>&1
#
# The hard ceiling is separate and belongs to the daemon: /etc/docker/
# daemon.json sets builder.gc maxUsedSpace=10GB, minFreeSpace=20GB.
set -uo pipefail

# Build cache younger than this is kept — the next deploy reuses it, and the
# daemon's GC caps the total no matter what this leaves.
CACHE_KEEP="${CACHE_KEEP:-168h}"

inuse="$(mktemp)"
trap 'rm -f "$inuse"' EXIT

# Every container, not just running ones: a stopped container is still a
# rollback target and its image must survive.
docker ps -aq | xargs -r docker inspect -f '{{.Image}}' | sort -u > "$inuse"

removed=0
for id in $(docker images --no-trunc --format '{{.ID}}' | sort -u); do
  grep -qx "$id" "$inuse" && continue
  # -f: an image can carry several tags; failing on one must not stop the sweep.
  if docker rmi -f "$id" >/dev/null 2>&1; then
    removed=$((removed + 1))
  fi
done

docker builder prune -f --filter "until=$CACHE_KEEP" >/dev/null 2>&1 || true

echo "docker-gc: images_removed=$removed cache_kept=$CACHE_KEEP disk=$(df -h / | awk 'NR==2{print $5" used, "$4" free"}')"
