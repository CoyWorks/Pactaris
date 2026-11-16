# ADR 0001 — First foundation runtime and Identity candidate

Date: 2026-11-16. Status: accepted for development foundation; provider acceptance and production sizing remain open.

Use Node.js 24, TypeScript, Express and PostgreSQL/Drizzle for the Instance. Serve a static React/Vite status UI from the Instance origin. The selected exact dependencies are in package-lock.json; release protocol 1 currently prohibits database migrations. A small connection pool and a dedicated heartbeat worker provide executable runtime boundaries, not a claim of production job processing.

Use authentik 2026.8.5 as the first Identity evaluation candidate, matching the official Compose definition retrieved on this date. Its Docker Compose lifecycle is separate from the Instance's systemd units; do not replace the vendor identity implementation with custom password/OIDC code. Database and media volumes stay in the Identity project. Do not expose its database or mount the Docker socket. Image upgrades require a reviewed provider migration/restore runbook and are blocked by the first updater.

Two application components share a source repository, translation resources and contracts, but no runtime config, migration lock, database credentials or implicit restart. Operator-approved GitHub commits are pinned; independent updates preserve the selected component's state. Default private HTTPS app ports are configurable (Identity 9443, Instance 9444); public origins and TLS names are explicit configuration and may use unrelated parent domains.

The status service returns readiness 503 if PostgreSQL cannot be reached. Proxy identity headers never establish a session. No tenant-data API or login is enabled until reviewed OIDC sessions, tenant policies and consent/safety guards are implemented.

Alternatives considered in ARCHITECTURE.md remain background context. No new PHP/Python application backend is introduced; Python is used only for operational install/update tooling. Systemd is the host process supervisor; the authentik Compose runtime is the documented dependency exception.

Pending evidence: real PostgreSQL, provider registration/recovery/MFA, Google/Apple callbacks, central OIDC session validation, actual CloudPanel/TLS, reboot, complete first-install/update recovery, media/off-host backups and capacity tests. No issue is completed solely by this ADR.
