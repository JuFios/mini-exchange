#!/bin/sh
set -eu

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${ENGINE_DB_PASSWORD:?ENGINE_DB_PASSWORD is required}"
: "${LEDGER_DB_PASSWORD:?LEDGER_DB_PASSWORD is required}"
export PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=10

# CREATE DATABASE не можна помістити в TX. Session lock тримає весь bootstrap разом,
# а кожен уже закомічений крок можна безпечно повторити після обриву.
# Пара (734021, 3) зарезервована в apps/matching-engine-service/src/database/advisory-lock.ts.
psql --no-psqlrc -v ON_ERROR_STOP=1 -h exchange-db -U exchange -d postgres <<'SQL'
\getenv engine_password ENGINE_DB_PASSWORD
\getenv ledger_password LEDGER_DB_PASSWORD
SET lock_timeout = '60s';
SET statement_timeout = '5min';
SELECT pg_advisory_lock(734021, 3);

SELECT 'CREATE ROLE engine' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'engine')
\gexec
SELECT 'CREATE ROLE ledger' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledger')
\gexec
SELECT 'CREATE DATABASE exchange OWNER engine ALLOW_CONNECTIONS false'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'exchange')
\gexec
SELECT 'CREATE DATABASE ledger OWNER ledger ALLOW_CONNECTIONS false'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ledger')
\gexec

BEGIN;
ALTER DATABASE exchange OWNER TO engine;
ALTER DATABASE ledger OWNER TO ledger;
REVOKE CONNECT ON DATABASE exchange, ledger FROM PUBLIC;
ALTER DATABASE exchange ALLOW_CONNECTIONS true;
ALTER DATABASE ledger ALLOW_CONNECTIONS true;
ALTER ROLE engine WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD :'engine_password';
ALTER ROLE ledger WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD :'ledger_password';
COMMIT;

SELECT pg_advisory_unlock(734021, 3);

\connect exchange
BEGIN;
SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(734021, 3);

-- На томах зі старої схеми об’єкти належать попередній ролі застосунку.
SELECT format('ALTER TABLE %I.%I OWNER TO engine', n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relowner = 'exchange'::regrole AND c.relkind IN ('r', 'p')
ORDER BY c.relname
\gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO engine', n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relowner = 'exchange'::regrole AND c.relkind = 'S'
ORDER BY c.relname
\gexec
COMMIT;
SQL
