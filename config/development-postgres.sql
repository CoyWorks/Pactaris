-- Synthetic loopback-only credentials for compose.development.yaml.
CREATE ROLE instance_dev_runtime LOGIN PASSWORD 'dev-fixture-runtime-only';
CREATE ROLE instance_dev_migration LOGIN PASSWORD 'dev-fixture-migration-only';
CREATE ROLE instance_dev_backup NOLOGIN BYPASSRLS;

REVOKE ALL ON DATABASE instance_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE instance_dev TO instance_dev_runtime, instance_dev_migration;
GRANT CREATE ON DATABASE instance_dev TO instance_dev_migration;
