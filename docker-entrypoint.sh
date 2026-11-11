#!/bin/sh
set -e

role="${1:-web}"
export LOGBUCH_PROCESS="$role"

case "$role" in
  web)
    exec node server.js
    ;;
  worker)
    exec node dist/worker.mjs
    ;;
  migrate)
    exec node dist/migrate.mjs
    ;;
  directory-sync)
    exec node dist/directory-sync.mjs
    ;;
  *)
    exec "$@"
    ;;
esac
