#!/usr/bin/env bash
#
# Pre-migration safety dump (Audit P0-8). Run a fresh backup, THEN migrations,
# so a destructive/buggy migration can always be rolled back to the exact
# pre-migration state. Wire this into the deploy pipeline instead of calling
# `migration:run` directly.
#
# Usage:  scripts/pre-migration-backup.sh && npm run migration:run
#   or:   npm run migration:run:safe   (see package.json)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[pre-migration] taking a safety backup before running migrations…"
BACKUP_DIR="${BACKUP_DIR:-./backups/pre-migration}" "${SCRIPT_DIR}/backup-db.sh"
echo "[pre-migration] backup complete — safe to migrate."
