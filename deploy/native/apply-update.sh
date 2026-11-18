#!/bin/sh
set -eu

UPDATE_HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET_HOME=${1:-}

if [ -z "$TARGET_HOME" ]; then
  echo "Usage: ./apply-update.sh /path/to/dw-resource-console"
  exit 1
fi

TARGET_HOME=$(CDPATH= cd -- "$TARGET_HOME" && pwd)
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_HOME="$TARGET_HOME/backups/incremental-$STAMP"

if [ ! -d "$TARGET_HOME/apps/api" ] || [ ! -d "$TARGET_HOME/apps/web" ]; then
  echo "Target does not look like a dw-resource-console deployment: $TARGET_HOME"
  exit 1
fi

replace_dir() {
  SOURCE=$1
  TARGET=$2
  NAME=$3
  if [ ! -d "$SOURCE" ]; then
    return
  fi
  mkdir -p "$BACKUP_HOME"
  if [ -d "$TARGET" ]; then
    mv "$TARGET" "$BACKUP_HOME/$NAME"
  fi
  mkdir -p "$(dirname -- "$TARGET")"
  cp -a "$SOURCE" "$TARGET"
}

if [ -f "$TARGET_HOME/stop-api.sh" ]; then
  "$TARGET_HOME/stop-api.sh" || true
fi

replace_dir "$UPDATE_HOME/apps/api/dist" "$TARGET_HOME/apps/api/dist" "api-dist"
replace_dir "$UPDATE_HOME/apps/web/dist" "$TARGET_HOME/apps/web/dist" "web-dist"
replace_dir "$UPDATE_HOME/packages/shared/dist" "$TARGET_HOME/packages/shared/dist" "shared-dist"
replace_dir \
  "$UPDATE_HOME/apps/api/node_modules/@dw/shared" \
  "$TARGET_HOME/apps/api/node_modules/@dw/shared" \
  "api-shared-runtime"
replace_dir "$UPDATE_HOME/apps/api/drizzle" "$TARGET_HOME/apps/api/drizzle" "drizzle"
replace_dir "$UPDATE_HOME/apps/api/drizzle-pg" "$TARGET_HOME/apps/api/drizzle-pg" "drizzle-pg"

if [ -f "$UPDATE_HOME/data/dw_console_data.sql" ]; then
  mkdir -p "$TARGET_HOME/data"
  if [ -f "$TARGET_HOME/data/dw_console_data.sql" ]; then
    mkdir -p "$BACKUP_HOME"
    cp -a "$TARGET_HOME/data/dw_console_data.sql" "$BACKUP_HOME/dw_console_data.sql"
  fi
  cp -a "$UPDATE_HOME/data/dw_console_data.sql" "$TARGET_HOME/data/dw_console_data.sql"
fi

echo "Incremental files applied."
echo "Backup: $BACKUP_HOME"
echo "Review migrations/imports, then run: $TARGET_HOME/start-api.sh"
