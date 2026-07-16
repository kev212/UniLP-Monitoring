#!/bin/sh
set -eu

env_file="${ENV_FILE:-.env}"
compose_file="${COMPOSE_FILE:-docker-compose.yml}"
db_name="${POSTGRES_DB_NAME:-unilp}"
db_user="${POSTGRES_USER_NAME:-unilp}"

case "$db_name:$db_user" in
  *[!A-Za-z0-9_:-]*) echo "Database name and user must be alphanumeric or underscore" >&2; exit 1 ;;
esac

[ -f "$env_file" ] || { echo "Missing $env_file" >&2; exit 1; }
password="$(openssl rand -hex 32)"

set_env() {
  key="$1"
  value="$2"
  temp="$(mktemp)"
  found=false
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*) printf '%s=%s\n' "$key" "$value" >> "$temp"; found=true ;;
      *) printf '%s\n' "$line" >> "$temp" ;;
    esac
  done < "$env_file"
  [ "$found" = true ] || printf '%s=%s\n' "$key" "$value" >> "$temp"
  mv "$temp" "$env_file"
}

# The old container remains reachable through its Unix socket during rotation.
docker compose -f "$compose_file" exec -T postgres psql -U "$db_user" -d "$db_name" -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE \"$db_user\" PASSWORD '$password';"

set_env POSTGRES_DB "$db_name"
set_env POSTGRES_USER "$db_user"
set_env POSTGRES_PASSWORD "$password"
set_env EXECUTOR_PRIVATE_KEY_FILE_HOST "${EXECUTOR_PRIVATE_KEY_FILE_HOST:-./secrets/executor_private_key}"
chmod 600 "$env_file"

printf '%s\n' "PostgreSQL credentials rotated. Rebuild with docker compose up -d --build."
