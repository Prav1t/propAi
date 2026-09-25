#!/bin/sh
# creates the least-privilege runtime role (no SUPERUSER, no BYPASSRLS) on first boot
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER:-propai_app}') THEN
    CREATE ROLE ${APP_DB_USER:-propai_app} LOGIN PASSWORD '${APP_DB_PASSWORD:-propai_app}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER:-propai_app};
SQL
