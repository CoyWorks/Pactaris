# Milestone 1 — Independently installable Identity and Instance

Status: in progress. Target: 0.1.0-alpha.1 development foundation. This is not a public-production release or completion of all M0 issues.

## Goal

Install Identity and a minimal Instance separately, connect them through configured public origins/OIDC, and update either component from a pinned GitHub revision while preserving its configuration and data. Start empty; no legacy identities/content import.

## Work order

| Step | Issues | Deliverable |
| --- | --- | --- |
| Architecture/reference/rights | #1, #2, #50 | Record runtime and component boundaries; original implementation with third-party notices |
| Scaffold and messages | #3, #44 | Independent component configuration/builds, English catalogs, locale utilities and checks |
| Instance data and contract | #4, #55 | PostgreSQL-backed readiness, stable instance identity and minimal service/worker status |
| Installation and updates | #56 | Component-specific install/update/status, pinned source, locks, preserved config/data and health gates |
| Identity integration | #6, #58 | Authentik candidate deployment and real OIDC code/PKCE integration with local instance sessions |
| Proxy and registration | #28, #57 | Verified TLS/proxy instructions and minimal scoped instance enrollment/status |
| Runtime evidence | #13, #62 | Repeat install, split placement, preserving update and controlled failure tests |

Broader issues remain open until every acceptance criterion is satisfied. Track partial implementation without closing them prematurely.

## Scope and checkpoints

### A. Executable foundation — first checkpoint

- Independent Identity deployment definition and Instance runtime; no hidden shared config/database dependency.
- Configurable public origin, issuer/client/callback, private bind address, port and TLS identity. Defaults: Identity HTTPS 9443, Instance HTTPS 9444.
- Instance health/readiness/version endpoints, private PostgreSQL connection and worker entry point; no unauthenticated tenant-data endpoints.
- English message catalog and typed keys/parameter conventions; user content is never translated automatically.
- Installer/updater/status tooling with safe preflight/planning mode before host changes.
- CI builds and tests config boundaries, i18n, HTTP health behavior and installer failure/preservation paths.

### B. Install/update acceptance

- Identity and Instance can each be installed without the other or CloudPanel; an optional convenience action composes them.
- Fresh install, repeated install, service restart/reboot and a second pinned revision update preserve instance ID, secrets, settings, database and files.
- Read-only private GitHub access works without embedding tokens in URLs/logs. New release is staged and verified before activation.
- Database migrations/checkpoints and rollback limits are explicit. Failed builds do not replace the current healthy release.
- Identity-only and Instance-only updates do not implicitly alter the other.

### C. Connected alpha

- Central local-account login and real OIDC authorization code/PKCE callback produce an independent secure instance session.
- Google and Apple require real configured provider credentials/callbacks; mocks never count as provider acceptance.
- Basic protected status/start page plus minimal authenticated registration/placement contract.
- Real PostgreSQL and split-host/proxy tests, then the first household/relationship/consent/task slice with tenant isolation and safe export/leave.

## Explicit limits

No public onboarding, payment checkout, completed fleet management, full Obedience parity or live OCI deployment is implied by checkpoint A. Households/tasks cannot be exposed before #5/#9/#10/#11 are implemented and verified. Health pages are operational status, not authorization shortcuts.

Authentik is the initial implementation candidate, not a claimed validated production choice. Its Compose runtime is a separately managed dependency; the Node instance uses systemd. Pin and record the tested provider version. No local Docker/PostgreSQL availability or real provider credentials are assumed.

## Evidence log

Update this section and relevant issues after each checkpoint with commits, commands/results and unverified dependencies. Never record secrets, tokens or real household records.

- 2026-11-16: milestone recorded; repository inspected; implementation starting. No application services deployed.
