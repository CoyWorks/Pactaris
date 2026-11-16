# Decisions and remaining implementation choices

Updated 16 November 2026. Current user decisions override earlier planning alternatives.

## Confirmed

| Topic | Decision |
| --- | --- |
| Product | Public consenting-adult BDSM/SM/kink platform; Obedience as functional inspiration, original implementation |
| Domain | Multiple contextual roles/relationships; technical rights separate from dynamic roles |
| Runtime | React/Vite; Node.js/TypeScript/Express; PostgreSQL/Drizzle; systemd |
| Hosting | Initial co-location behind CloudPanel, with independently deployable Identity/Instance and separate data boundaries; remote instances over private LAN |
| Identity methods | Google + Apple + local verified email/password account creation, through a maintained central identity service exposing OIDC |
| Legacy data | None: empty new product; prior Site only a reference |
| First slice | Login, dynamic/invites, contextual relationships, consent/pause and task lifecycle, with export/leave |
| First-slice infrastructure | Service/data boundaries, minimum instance registration/status and GitHub install/update/status tooling; preserving second-version update |
| Updates | Approved pinned GitHub version/commit; staged checks/migrations/health and recovery; private-repo read access supported |
| Source rights | Proprietary/all rights reserved, LICENSE.txt; no open-source grant |
| Repo visibility | Public for now; owner intends private later; no automatic visibility change |
| Localization | English-only initially, mandatory key catalogs and independent locale/timezone from M0 |
| Changes | Approximately 60-second visible-app checks plus opt-in Web Push; no permanent-socket requirement |
| Plans | Free/paid entitlement architecture in core; prices/exact capacities not finalized |

## To resolve during implementation

| Choice | Scope / issue |
| --- | --- |
| Identity product | Select maintained broker/service supporting all three methods, local recovery/MFA and central OIDC; #6/#58 |
| Provider setup | Google OAuth client, Apple developer/App ID/Services ID/keys/return URLs/relay-email setup; test real integrations |
| Domains and servers | Central and instance origins, actual host CPU/RAM/disk, private addresses and allowed proxy sources; #1/#28 |
| Update trust/access | Version policy, artifact verification, instance read-only deploy credentials and source-private transition; #56 |
| Safety semantics | Individual/relationship/household scope, explicit resume and queued-work disposition; #11 |
| Storage/email | Private storage backend, sender/provider, size limits and retention; #21/#24 |
| Recovery/operations | RPO/RTO, backup key custody, restore rehearsal, source/proxy/identity outages; #29/#31 |
| Public launch | Adult-service policy, retention/data requests, support/reporting, pilot gates; #32/#34 |
| Commercial release | Sponsor scope/transfer, exact quotas/prices, provider suitability and graceful downgrade; #42/#54/#61 |
| Provenance | Existing-source and dependency rights/notices; proprietary notice does not replace third-party licenses; #50 |

Read [DOMAIN_MODEL.md](DOMAIN_MODEL.md), [INTERNATIONALIZATION.md](INTERNATIONALIZATION.md), [PLANS.md](PLANS.md), [INFRASTRUCTURE.md](INFRASTRUCTURE.md) and [INSTALL_UPDATE.md](INSTALL_UPDATE.md). Safety, privacy, basic MFA, personal export, stop/leave/delete are not subscription upsells.

## Explicit deployment contract

Identity and Instance are separately installable/updatable applications, not one central bundle. CloudPanel/proxy, Identity, manager and Instance may be hosted separately later without code changes. Defaults: CloudPanel administration 8443 (existing), Identity HTTPS 9443, every Instance HTTPS 9444. Ports, listen address, public origin and backend/TLS identity are configuration. Remote instance2 upstream resolution must use the private backend, not public proxy IP. See [INFRASTRUCTURE.md](INFRASTRUCTURE.md) for the user's example map and verification requirements. These are planning defaults, not configured services.

## Domain decision

All domains/subdomains and per-service origins are configurable. Start on coyworks.nl; a future unrelated domain such as pactaris.app is possible but not selected/verified. No code assumes a fixed suffix or shared parent domain. Public-origin/issuer migration, unlike backend relocation, requires a tested identity/session/PWA/push/link cutover plan; see docs/INFRASTRUCTURE.md and #58/#62. No live domain/DNS changes are performed during planning.
