#!/bin/sh
set -eu

is_true() {
  case "$(printf '%s' "${1:-false}" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

if ! is_true "${DB_CREATE_TABLES:-false}" && ! is_true "${DB_IMPORT_DATA:-false}"; then
  echo "[db-init] No table creation or data import requested. Skipping."
  exit 0
fi

if is_true "${DB_CREATE_TABLES:-false}"; then
  echo "[db-init] Applying schema-aware migrations to schema ${DB_SCHEMA:-public}"
  node apps/api/dist/db/migrate.js
fi

if is_true "${DB_IMPORT_DATA:-false}"; then
  echo "[db-init] Importing SQL data into schema ${DB_SCHEMA:-public}"
  node apps/api/dist/db/import-data.js
else
  echo "[db-init] Data import is disabled."
fi
