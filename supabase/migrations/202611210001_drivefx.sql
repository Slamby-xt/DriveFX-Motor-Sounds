-- Apply as the database owner, then provision a password for the runtime role.
BEGIN;

CREATE SCHEMA drivefx;
REVOKE ALL ON SCHEMA drivefx FROM PUBLIC;
CREATE ROLE drivefx_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE drivefx_app SET search_path TO pg_catalog;
GRANT USAGE ON SCHEMA drivefx TO drivefx_app;

-- The owner must explicitly set 'prod' in the separate production database.
CREATE TABLE drivefx.environment (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  name text NOT NULL CHECK (name IN ('prod', 'sandbox'))
);
INSERT INTO drivefx.environment (name) VALUES ('sandbox');
GRANT SELECT ON drivefx.environment TO drivefx_app;

CREATE TABLE drivefx.records (
  key text PRIMARY KEY CHECK (key ~ '^(lic|sub|pi|loss|billing):'),
  value jsonb NOT NULL
);
CREATE INDEX records_device_idx ON drivefx.records ((value ->> 'device'))
  WHERE split_part(key, ':', 1) IN ('sub', 'pi');

CREATE TABLE drivefx.customers (
  customer text NOT NULL,
  device text NOT NULL CHECK (device ~ '^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  PRIMARY KEY (customer, device)
);
CREATE INDEX customers_device_idx ON drivefx.customers (device);

CREATE TABLE drivefx.transient (
  key text PRIMARY KEY CHECK (key ~ '^(tr|rl|ev|lease|checkout):'),
  value jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX transient_expiry_idx ON drivefx.transient (expires_at);

REVOKE ALL ON ALL TABLES IN SCHEMA drivefx FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON drivefx.records, drivefx.customers, drivefx.transient TO drivefx_app;

-- Use an isolated project whose public schema has no application objects.
-- Revoke the implicit schema privileges inherited by every database role.
REVOKE USAGE, CREATE ON SCHEMA public FROM PUBLIC;
COMMIT;
