# Managed instances and server manager

**Distributed-network clarification — 17 November 2026:** Instances need not share a LAN. The planned platform-operator portal, cross-network connectivity, minimal household inventory and controlled relocation are specified in [INSTANCE_MANAGER.md](INSTANCE_MANAGER.md). End users remain on one canonical product origin; per-Instance browser origins in historical topology examples are superseded. Everyday household basics remain the current implementation priority.

Status: architecture proposal, 16 November 2026. Requirements: independent app instances, each with its own hosting, database, files, worker and lifecycle; multiple isolated households per instance. This is infrastructure for the public hosted product, not a return to public self-hosted editions.

## Identity and Instance are separate applications

Identity and Instance must each be installable, deployable, updatable and movable without installing the other application or CloudPanel. A shared repository/library is allowed; mandatory shared runtime, config files, database, migration lock or release pointer is not. Keep identity data and tenant data separate, and use OIDC over verified network contracts.

Initial example, not a live configuration:

| Public origin (HTTPS 443) | Backend as resolved from the proxy | Purpose |
| --- | --- | --- |
| panel.coyseinri.nl | https://127.0.0.1:8443 | Existing CloudPanel admin |
| identity.coyworks.nl | https://127.0.0.1:9443 | Identity application |
| instance1.coyworks.nl | https://127.0.0.1:9444 | Local Instance application |
| instance2.coyworks.nl | https://instance2.coyworks.nl:9444, with internal DNS resolving to the remote private host | Remote Instance application |

9443 and 9444 are configurable default HTTPS ingress ports, checked for conflicts. Every instance uses the same application/default port on its own host. Multiple instances on one host need distinct endpoints/paths. 8443 belongs to existing CloudPanel administration and is not reused by Identity/Instance.

The instance2 upstream hostname must resolve from the proxy to the actual private backend, not back to the public proxy. Use split DNS or a distinct internal backend name/private IP. Keep public origin, backend target, listen interface/port and verified TLS server name as separate settings.

Verify backend TLS against the configured trusted identity. A hostname certificate does not automatically cover 127.0.0.1: configure an explicit trusted TLS name/SNI or a certificate with the correct IP SAN. Do not disable backend certificate validation. No ports, domains or private addresses are hardcoded into feature logic.

Adding another proxy or moving Identity/Instance to separate hosts must work through configuration while preserving the public origins/issuer. Changing the public OIDC issuer itself requires controlled trust/session migration, not just swapping an internal address. CloudPanel is external ingress; neither application requires it locally.

## Control and data planes

```mermaid
flowchart TD
  M["Server manager / control plane"] --> D["Placement and entitlement metadata"]
  M --> A["Instance A / hosting and agent"]
  M --> B["Instance B / hosting and agent"]
  A --> AP["A: private PostgreSQL, files and workers"]
  B --> BP["B: private PostgreSQL, files and workers"]
  AP --> AH["Households A1, A2 / isolated tenants"]
  BP --> BH["Households B1, B2 / isolated tenants"]
```

Arrows represent scoped orchestration/ownership, not a requirement that the manager directly connects to instance databases. Each instance database serves only that instance. Household isolation remains necessary inside every instance.

| Component | Owns | Does not routinely receive |
| --- | --- | --- |
| Manager registry | Instance IDs/endpoints, versions, capacity, health, placement and maintenance state | Tasks, scenes, limits, private attachments or relationship graph |
| Platform identity service | Verified account subject and authentication/recovery state | Tenant content; household role permissions |
| Billing/entitlements | Sponsor, plan version, status, aggregate usage and invoices | Intimate relationship/session metadata |
| Instance | Local subject mapping, memberships, tenant domain data, local sessions, jobs, files and backups | Other instances' database/storage credentials |
| Household | Its scoped members, agreements, workflows and content | Another household's data even on the same instance |

The manager may host identity/billing modules initially, but keep their privileges and stored data explicit. No single shared tenant-content PostgreSQL server is the required fleet model.

## Instance contract

Record a stable instance ID, authenticated endpoint, region, supported CPU/OS/runtime, installed application/schema version, protocol compatibility, capacity/usage, health, backup freshness and lifecycle state. Give each instance separate runtime/database/storage/agent credentials and backup ownership.

A server may initially host Identity and the main Instance as separate installations; each Instance has its own stable ID and lifecycle. Preserve IDs/interfaces when moving components to separate physical/virtual hosts. Co-locating manager and first instance is possible with separate services, secrets and databases, but gives no hardware or root-compromise isolation. Do not claim HA from multiple tenant databases or backup jobs.

Use existing OCI/CloudPanel infrastructure first. Each instance has a defined application origin/hosting boundary and its own database/storage. CloudPanel can terminate TLS and proxy to its app; database ports stay private. If proxy and app are on different hosts, use authenticated/protected private connectivity instead of assuming loopback. Do not install a second public listener over CloudPanel's ports.

## Installation and enrollment

Planned operator flow, not an available command yet:

1. Prepare a supported VM and confirm resources, DNS/TLS, proxy and private ports.
2. Run the versioned installer with a secret-safe configuration input. Preflight before mutation; repeated runs preserve data and existing secrets.
3. Install app/API, worker/scheduler, private PostgreSQL/storage and supervision. Runtime uses an unprivileged service identity.
4. In the manager, create a short-lived enrollment token bound to the expected instance.
5. The instance establishes authenticated TLS, proves identity and exchanges the token once for scoped, rotatable instance credentials.
6. Verify version compatibility, storage/database access, health, backups and restart/reboot behavior before marking it ready.
7. Enable household placement only after readiness passes.

Enrollment must define certificate/key bootstrap, renewal, revocation, replay protection and recovery. Do not store enrollment tokens in URLs, shell arguments or logs. Manager actions are allowlisted and audited with operator MFA; the agent is not an arbitrary remote root shell. Prefer a pull-based management channel where practical.

Installer: [#56](https://github.com/CoyWorks/Pactaris/issues/56). Enrollment/inventory: [#57](https://github.com/CoyWorks/Pactaris/issues/57). Contract: [#55](https://github.com/CoyWorks/Pactaris/issues/55).

## Placement and identity

Use a stable platform subject for the independent account and map it to local membership in each instance. Authentication credentials need not be duplicated across tenant databases. The proposed identity service uses a maintained authentication/OIDC solution; the exact choice remains open.

The manager directory maps a household to exactly one active home instance, with placement version and lifecycle. Creating a household uses idempotency and capacity reservation; retries cannot create two active homes. Household content and relationship joins stay local.

A user can enter through a common dashboard and choose only households they are authorized to access, including households on different instances. Use verified SSO redirects and audience-bound instance-local sessions; do not share broad wildcard cookies or forward account bearer tokens to arbitrary endpoints. Household admins cannot discover a member's other dynamics.

Validate instance, subject, session, membership and resource on every request. Instance-local membership revocation is immediate. Define bounded propagation for global account/session revocation and directory updates. See [#58](https://github.com/CoyWorks/Pactaris/issues/58).

## Outage behavior

| Failure | Required behavior |
| --- | --- |
| Manager/registry unavailable | Existing valid local sessions continue permitted local work and safety actions; new placement/enrollment is unavailable |
| Central identity unavailable | Existing valid local sessions remain bounded by their lifetime; new sign-in/refresh may fail; never fail open |
| Billing/provider unavailable | Use last valid versioned entitlement with explicit grace; preserve safe existing access and cap new billable growth |
| One instance unavailable | Other instances remain isolated/operational; show the affected dynamic unavailable, not empty or successfully stopped |
| User's network offline | Clearly show no server acknowledgement for stop or changes; no emergency-service guarantee |
| Worker/delivery outage | Preserve in-app safety state, alert operator and retry only still-authorized jobs |

Safety must not require a fresh manager RPC on every local action. This does not promise offline authentication or operation of a failed data-plane server. Define what is cached, its lifetime and revocation limits before implementation.

## Operations

Version and authenticate manager/agent commands. Use canary/batched upgrades, backups before risky migration, compatibility checks, health gates and a documented recovery path. A failed irreversible schema migration cannot be undone by merely rolling back application code.

Drain stops new placements, not existing members' safety/exit access. Maintenance and retirement have explicit states. Retire only after confirmed relocation/export/deletion, backup-retention handling and credential revocation. Keep each instance's backup keys/access separate and reconcile deletion/placement tombstones after recovery.

Aggregate only operational metrics: capacity, queue lag, versions, errors and backup freshness. No scene names, limits, private notes, participant graph or attachment names in fleet telemetry.

## Moving a household

Prepare placement/version interfaces now; implement automated relocation later ([#60](https://github.com/CoyWorks/Pactaris/issues/60)). Export/import tenant data and files with verified identities, reconcile usage/jobs/outbox/deletion, fence source writes, validate checksums/counts and switch the directory once. Only one instance accepts active writes. Handle token audiences, stale sessions, feed URLs, callbacks and queued notifications explicitly; a move must not duplicate point grants or reminders.

Do not use continuous cross-instance content joins or a distributed dual-write database mesh for the MVP.

## Delivery order

1. Define instance and identity/placement contracts in M0: [#55](https://github.com/CoyWorks/Pactaris/issues/55), [#58](https://github.com/CoyWorks/Pactaris/issues/58).
2. Build the first instance with entitlement hooks ([#53](https://github.com/CoyWorks/Pactaris/issues/53)), local isolation and durable workers.
3. Implement the installer, registry/enrollment and lifecycle: [#56](https://github.com/CoyWorks/Pactaris/issues/56), [#57](https://github.com/CoyWorks/Pactaris/issues/57), [#59](https://github.com/CoyWorks/Pactaris/issues/59).
4. Run two independent databases/stores and manager-outage tests in [#62](https://github.com/CoyWorks/Pactaris/issues/62) before second-instance public onboarding.
5. Add full tenant relocation and paid-plan reconciliation: [#60](https://github.com/CoyWorks/Pactaris/issues/60), [#61](https://github.com/CoyWorks/Pactaris/issues/61).

No Kubernetes, automatic multi-region failover or unrestricted remote management is required. The two-plane boundary is required from the core even while there is only one instance.

## Confirmed first delivery

The initial central identity service must support Google, Apple and local verified email/password accounts. Every instance receives central OIDC identity and manages local sessions/rights. Production databases start empty, with no imported Site accounts/content.

Central CloudPanel is the public proxy for local main/identity services and private-LAN instances. Internal servers need no CloudPanel. Use systemd and isolated databases/credentials; verified TLS and restricted proxy sources on the LAN. Public proxy failure and manager failure are distinct operational conditions.

#56 is M0: ship GitHub-based install.sh/update.sh/status.sh with the first working slice, including a minimum registered-instance/status path. See [INSTALL_UPDATE.md](INSTALL_UPDATE.md). Preserve a second pinned-version update in the initial acceptance demo. Advanced manager-driven canary/drain/retirement (#59) follows the same safe updater contract. Support read-only source access after the repository becomes private. The install/update/status scripts exist; see [INSTALL_UPDATE.md](INSTALL_UPDATE.md).

## Independent component releases

An Identity update never implicitly migrates/restarts an Instance, or vice versa. Keep component artifacts, service identities, configuration, secret stores, data migrations, locks and rollback checkpoints independent. Validate supported OIDC/manager contract versions when selecting a release. Manager is an independently configured service endpoint with its own operations boundary; do not assume it lives in localhost or either application database. See #3/#55/#56/#58/#59/#62.

## Configurable domains and future public-origin migration

The owner confirmed purchase of pactaris.app, which is the live product origin; coyworks.nl remains in use for existing Identity settings. Every service origin/subdomain is configurable. Individual services can also use unrelated parent domains. The earlier example proxy map is deployment data, not application constants.

Keep base-domain convenience settings separate from explicit canonical Identity issuer/origin, manager origin, each Instance origin, callback/logout allowlists, private backend target and TLS server name. Use validated URL builders and exact allowlists; host-scoped sessions must not infer trust from sharing a domain suffix. Releases/installers preserve operator configuration.

Moving a backend behind the same public origin differs from changing the public origin/issuer. For a domain change, prepare a tested runbook covering DNS and certificates, proxy routes, Google/Apple provider registrations, OIDC discovery/issuer/trust, stable account subjects, sessions/re-login and revocation, exact CORS/CSRF/callback/logout rules, PWA installations/service workers and push-device re-registration. Inventory pending invites, email links, secret calendar feeds and integrations; define which links redirect, expire or are reissued. Never place secrets into unsafe redirects or claim old browser state automatically moves to another origin.

Preserve internal user, household and instance IDs/data during cutover. Rehearse old/new origins using synthetic test domains, include user communication and health checks, and define rollback limits once new-domain sessions/content have been created. This is future deployment capability, not authorization to change live DNS or repository visibility now. See #6/#23/#28/#56/#58/#62.

## Updated public entry and installer decision — 16 November 2026

[INSTALLER_EXPERIENCE.md](INSTALLER_EXPERIENCE.md) supersedes earlier browser-facing Instance-origin examples: user traffic stays on one configurable product origin and household selection routes privately through the gateway. Use pactaris.app as the future product-domain default example; preserve current CoyWorks configuration until an explicit migration. Instance URLs remain operational backend endpoints. The desired installer normal path asks only component selection and hostname; database/runtime/TLS/OIDC/proxy/renewal/enrollment configuration is automated against a trusted fleet profile. Current alpha scripts and direct-instance blueprint do not implement that target yet.
